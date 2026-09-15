import {
  buildFlashPlan,
  DRY_RUN_BANNER,
  FLASH_WRITE_BANNER,
  KNOWN_MP9_UF2_FILENAME,
  emptyFlashPlanView,
  formatFlashPlan,
  formatStoredConfig,
  parseStoredConfig,
} from "./flashPlan.js";
import { programAcceptedFlashPlan, rebootAfterVerifiedFlash } from "./flashProgram.js";
import { fetchFirmwareManifest } from "./firmwareDist.js";
import { prepareFirmwareUpdate } from "./firmwareUpdate.js";
import {
  DEFAULT_FIRMWARE_MANIFEST_URL,
  FW_UPDATE_UI_PHASE,
  canStartFirmwareFlash,
  canStartFirmwareInstall,
  evaluateUpdateCheck,
  formatFirmwareUpdatePhase,
  resolveFirmwareBootloaderEntry,
} from "./firmwareUpdateUi.js";
import { connectMiniCube } from "./discovery.js";
import { mp9Profile } from "./devices/mp9.js";
import {
  emptyPicobootProtocolInfo,
  isUserCancelledUsb,
  isWebUsbSupported,
  protocolInfoFromError,
  readEepromProbe,
  requestAndClaimPicoboot,
  releasePicoboot,
  testPicobootCommunication,
} from "./picoboot.js";
import { bindShell } from "./ui.js";

const BOOTLOADER_STATUS =
  "MP9 is in Firmware Update Mode. A USB drive named RPI-RP2 should appear. Next: Connect to Bootloader, then Analyze UF2 (Dry Run). Write UF2 stays off until Dry Run ACCEPT.";

const MANUAL_BOOTSEL_HANDOFF_STATUS =
  "Manual BOOTSEL required. Reconnect USB while holding BOOTSEL, then press Connect to Bootloader.";

const FIRMWARE_UPDATE_CONFIRM = [
  "Enter Firmware Update Mode?",
  "",
  "MP9 will restart as a USB drive named RPI-RP2. MIDI will disconnect.",
  "After that you can use Connect to Bootloader, Analyze UF2 (Dry Run), then Write UF2 (erase + verify).",
  "Reboot stays disabled until every page verifies. EEPROM is not in the erase range.",
  "",
  "Continue?",
].join("\n");

const shell = bindShell();
let session = null;
let bootloaderHandoff = false;
let picobootSession = null;
let stopPicobootUsbWatch = null;
let acceptedFlash = null;
let verifyTicket = null;
let awaitMidiAfterReboot = false;
let flashProgramLogLines = [];

/** @type {string} */
let fwUpdatePhase = FW_UPDATE_UI_PHASE.IDLE;
/** @type {string | null} */
let fwLatestVersion = null;
/** @type {string | null} */
let fwCurrentVersion = null;
/** @type {string | null} */
let fwMinEnterBootloader = null;
/** @type {object | null} prepared result from prepareFirmwareUpdate */
let pendingPreparedUpdate = null;
let firmwareUpdateInFlight = false;
/** Status shown when MIDI drops during bootloader handoff. */
let bootloaderHandoffStatus = BOOTLOADER_STATUS;

function publishFirmwareUpdatePanel({
  status,
  latest,
  detail,
  canInstall,
  current,
  userMessage,
  manualBootloader,
} = {}) {
  if (status != null) {
    fwUpdatePhase = formatFirmwareUpdatePhase(status);
  }
  if (latest !== undefined) {
    fwLatestVersion = latest;
  }
  if (current !== undefined) {
    fwCurrentVersion = current;
  }
  shell.setFirmwareUpdatePanel({
    status: fwUpdatePhase,
    current: fwCurrentVersion || "—",
    latest: fwLatestVersion || "—",
    detail,
    userMessage,
    manualBootloader,
  });
  if (canInstall != null) {
    shell.setInstallFirmwareEnabled(canInstall);
  } else {
    refreshInstallEnabled();
  }
}

function resetFirmwareUpdatePanel() {
  fwUpdatePhase = FW_UPDATE_UI_PHASE.IDLE;
  fwLatestVersion = null;
  fwCurrentVersion = null;
  fwMinEnterBootloader = null;
  publishFirmwareUpdatePanel({
    status: FW_UPDATE_UI_PHASE.IDLE,
    latest: null,
    current: null,
    detail: null,
    canInstall: false,
    manualBootloader: false,
  });
}

function refreshInstallEnabled() {
  shell.setInstallFirmwareEnabled(
    canStartFirmwareInstall({
      phase: fwUpdatePhase,
      inFlight: firmwareUpdateInFlight,
      hasMidiSession: Boolean(session),
      hasPicobootSession: Boolean(picobootSession),
    })
  );
}

function webUsbLabel() {
  return isWebUsbSupported() ? "Available" : "Not available";
}

function setFlashButtons({ write = false, reboot = false } = {}) {
  shell.setFlashWriteEnabled(write);
  shell.setFlashRebootEnabled(reboot);
}

function clearAcceptedFlash({ keepLog = false } = {}) {
  acceptedFlash = null;
  verifyTicket = null;
  setFlashButtons({ write: false, reboot: false });
  if (!keepLog) {
    flashProgramLogLines = [];
    shell.setFlashProgramLog("");
  }
}

function appendFlashLog(line) {
  flashProgramLogLines.push(line);
  if (flashProgramLogLines.length > 40) {
    flashProgramLogLines = flashProgramLogLines.slice(-40);
  }
  shell.setFlashProgramLog(flashProgramLogLines.join("\n"));
}

function fileIdentity(file) {
  if (!file) {
    return null;
  }
  return { name: file.name, size: file.size, lastModified: file.lastModified };
}

function sameFileIdentity(a, b) {
  return Boolean(a && b && a.name === b.name && a.size === b.size && a.lastModified === b.lastModified);
}

function canAcceptForWrite(plan, file, eepromBytes) {
  return (
    Boolean(plan?.ok) &&
    file?.name === KNOWN_MP9_UF2_FILENAME &&
    Boolean(picobootSession) &&
    picobootSession.info?.productId === 0x0003 &&
    eepromBytes instanceof Uint8Array &&
    eepromBytes.length === 256
  );
}

function showIdleBootloader(result = "Not connected", interfaceDump = "(not enumerated yet)") {
  shell.setBootloaderConnected(false);
  shell.setBootloaderInfo({
    webusb: webUsbLabel(),
    result,
    chip: "—",
    vidPid: "—",
    product: "—",
    serial: "—",
    iface: "—",
    endpoints: "—",
    interfaceDump,
  });
  shell.setPicobootProtocol(emptyPicobootProtocolInfo());
}

function showPicobootInfo(info, result) {
  const classHex = `0x${Number(info.claimedClass).toString(16).toUpperCase().padStart(2, "0")}`;
  shell.setBootloaderConnected(true);
  shell.setBootloaderInfo({
    webusb: webUsbLabel(),
    result,
    chip: info.chip,
    vidPid: info.vidPid,
    product: `${info.productName} (${info.manufacturerName})`,
    serial: info.serialNumber,
    iface: `#${info.claimedInterfaceNumber} alt ${info.claimedAlternateSetting} class ${classHex} subclass ${info.claimedSubclass} protocol ${info.claimedProtocol} (config ${info.configurationValue})`,
    endpoints: info.claimedEndpoints.join(", ") || "(none)",
    interfaceDump: info.interfaceDump,
  });
}

function isDisconnectError(error) {
  const message = error && error.message ? error.message : String(error);
  return /disconnected/i.test(message);
}

function fail(error) {
  const message = error && error.message ? error.message : String(error);
  shell.setStatus(message);
}

function dropSession() {
  if (session?.midi) {
    session.midi.close();
  }
  session = null;
}

function mountProfile(profile) {
  shell.clearDeviceView();
  const view = profile.mount(shell.deviceRoot);
  shell.setDeviceView(view, profile.capabilities);
  return view;
}

function showDisconnectedMp9Defaults() {
  mountProfile(mp9Profile);
  const defaults = mp9Profile.defaultConfig;
  shell.setConfig({
    midiChannel: defaults.midiChannel,
    padCc: [...defaults.padCc],
  });
}

async function withSession(work, busyStatus) {
  if (!session) {
    shell.setStatus("Connect a device first.");
    return;
  }
  shell.setStatus(busyStatus);
  shell.setBusy(true);
  try {
    await work(session);
  } catch (error) {
    if (bootloaderHandoff && isDisconnectError(error)) {
      shell.setStatus(bootloaderHandoffStatus);
      return;
    }
    fail(error);
  } finally {
    shell.setBusy(false);
    refreshInstallEnabled();
  }
}

async function checkPublishedFirmwareUpdate({ quiet = false } = {}) {
  if (firmwareUpdateInFlight) {
    if (!quiet) {
      shell.setStatus("Firmware update already in progress.");
    }
    return;
  }
  if (!session?.info?.firmware) {
    resetFirmwareUpdatePanel();
    if (!quiet) {
      shell.setStatus("Connect a device first.");
    }
    return;
  }

  publishFirmwareUpdatePanel({
    status: FW_UPDATE_UI_PHASE.CHECKING,
    current: session.info.firmware,
    detail: null,
    canInstall: false,
  });
  if (!quiet) {
    shell.setStatus("Checking for firmware updates…");
  }

  const fetched = await fetchFirmwareManifest(DEFAULT_FIRMWARE_MANIFEST_URL);
  if (!fetched.ok) {
    publishFirmwareUpdatePanel({
      status: FW_UPDATE_UI_PHASE.ERROR,
      latest: null,
      current: session.info.firmware,
      detail: fetched.error,
      canInstall: false,
    });
    if (!quiet) {
      shell.setStatus("Couldn't check for updates.");
    }
    return;
  }

  const outcome = evaluateUpdateCheck(session.info.firmware, fetched.manifest.version);
  fwMinEnterBootloader = fetched.manifest.minDeviceFirmwareForEnterBootloader;
  publishFirmwareUpdatePanel({
    status: outcome.phase,
    latest: fetched.manifest.version,
    current: session.info.firmware,
    detail: outcome.phase === FW_UPDATE_UI_PHASE.ERROR ? outcome.detail : null,
    canInstall: outcome.canInstall,
    manualBootloader: false,
  });
  if (!quiet) {
    shell.setStatus(
      outcome.phase === FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE
        ? `Update available: ${fetched.manifest.version}`
        : outcome.phase === FW_UPDATE_UI_PHASE.UP_TO_DATE
          ? "Firmware is up to date."
          : outcome.detail
    );
  }
}

async function flashPendingPreparedUpdate() {
  if (
    !canStartFirmwareFlash({
      hasPrepared: Boolean(pendingPreparedUpdate),
      hasPicobootSession: Boolean(picobootSession),
      productId: picobootSession?.info?.productId,
      phase: fwUpdatePhase,
    })
  ) {
    publishFirmwareUpdatePanel({
      status: FW_UPDATE_UI_PHASE.ERROR,
      detail: "Bootloader session (RP2040 PID 0x0003) and a prepared update are required before flash.",
      canInstall: false,
    });
    shell.setStatus("Flash refused: bootloader session or prepared update missing.");
    firmwareUpdateInFlight = false;
    refreshInstallEnabled();
    return;
  }

  const prepared = pendingPreparedUpdate;
  publishFirmwareUpdatePanel({
    status: FW_UPDATE_UI_PHASE.FLASHING,
    userMessage: "Installing firmware...",
    canInstall: false,
  });
  shell.setBusy(true);
  shell.setStatus(`Flashing verified ${prepared.fileName}…`);
  appendFlashLog(`Published update flash start: ${prepared.fileName}`);

  try {
    const probe = await readEepromProbe(picobootSession);
    const stored = parseStoredConfig(probe.payload);
    acceptedFlash = {
      fileName: prepared.fileName,
      plan: prepared.plan,
      eepromBytes: probe.payload,
      eepromText: formatStoredConfig(stored, {
        note: "Pre-update EEPROM probe for published firmware install.",
      }),
      storedConfig: stored,
    };
    shell.setFlashPlan({
      banner: FLASH_WRITE_BANNER,
      summary: formatFlashPlan(prepared.plan, prepared.fileName),
      eeprom: acceptedFlash.eepromText,
    });
    shell.setPicobootProtocol({
      commandName: probe.commandName,
      commandStatus: probe.commandStatus,
      response: `EEPROM probe ${probe.transferredBytes} bytes`,
      transferredBytes: String(probe.transferredBytes),
      protocolError: "—",
    });

    const livePlan = buildFlashPlan(prepared.download.uf2Bytes, {
      connected: true,
      productId: picobootSession.info.productId,
    });
    const result = await programAcceptedFlashPlan(
      picobootSession,
      {
        plan: prepared.plan,
        livePlan,
        fileName: prepared.fileName,
        eepromBytes: probe.payload,
      },
      {
        onProgress(event) {
          const line = `${event.phase}: ${event.commandName} ${event.detail || ""} ${event.total ? `(${event.current}/${event.total})` : ""}`.trim();
          appendFlashLog(line);
          shell.setStatus(`Flashing: ${line}`);
        },
      }
    );

    verifyTicket = result.ticket;
    setFlashButtons({ write: false, reboot: true });
    appendFlashLog(
      `VERIFY PASS: ${result.pageCount} pages. Rebooting after published update ${prepared.download.manifest.version}.`
    );

    publishFirmwareUpdatePanel({
      status: FW_UPDATE_UI_PHASE.FLASHING,
      userMessage: "Restarting device...",
      canInstall: false,
    });
    const rebootResult = await rebootAfterVerifiedFlash(picobootSession, verifyTicket);
    awaitMidiAfterReboot = true;
    verifyTicket = null;
    setFlashButtons({ write: false, reboot: false });
    shell.setPicobootProtocol(rebootResult);
    pendingPreparedUpdate = null;
    publishFirmwareUpdatePanel({
      status: FW_UPDATE_UI_PHASE.SUCCESS,
      latest: prepared.download.manifest.version,
      detail: null,
      canInstall: false,
    });
    shell.setStatus(
      `Firmware ${prepared.download.manifest.version} installed and rebooted. Press Connect when MIDI returns.`
    );
  } catch (error) {
    verifyTicket = null;
    setFlashButtons({ write: false, reboot: false });
    const protocol = protocolInfoFromError(error);
    shell.setPicobootProtocol(protocol);
    const message = error && error.message ? error.message : String(error);
    appendFlashLog(`Published update FAIL: ${message}`);
    publishFirmwareUpdatePanel({
      status: FW_UPDATE_UI_PHASE.ERROR,
      detail: message,
      canInstall: false,
    });
    shell.setStatus(`${message} Device stays in BOOTSEL. Reboot was not sent.`);
  } finally {
    firmwareUpdateInFlight = false;
    shell.setBusy(false);
    refreshInstallEnabled();
  }
}

async function installPublishedFirmwareUpdate() {
  if (firmwareUpdateInFlight) {
    shell.setStatus("Firmware update already in progress.");
    return;
  }
  if (
    !canStartFirmwareInstall({
      phase: fwUpdatePhase,
      inFlight: firmwareUpdateInFlight,
      hasMidiSession: Boolean(session),
      hasPicobootSession: Boolean(picobootSession),
    })
  ) {
    shell.setStatus("Install is only available when an update is available and a session is connected.");
    refreshInstallEnabled();
    return;
  }

  const current = session?.info?.firmware || fwCurrentVersion || "(unknown)";
  const latest = fwLatestVersion || "(unknown)";
  const previewEntry = fwMinEnterBootloader
    ? resolveFirmwareBootloaderEntry({
        currentFirmware: current,
        minEnterBootloader: fwMinEnterBootloader,
        hasPicobootRp2040: false,
      })
    : { action: "enter-bootloader" };
  const confirmLines =
    previewEntry.action === "manual-bootsel"
      ? [
          "Install published firmware update?",
          "",
          `Current: ${current}`,
          `Latest: ${latest}`,
          "",
          "This device firmware is older than the minimum that supports automatic bootloader entry.",
          "After download and verify, you must enter BOOTSEL manually (hold BOOTSEL while reconnecting USB), then Connect to Bootloader.",
          "",
          "Continue?",
        ]
      : [
          "Install published firmware update?",
          "",
          `Current: ${current}`,
          `Latest: ${latest}`,
          "",
          "The UF2 will be downloaded and SHA-256 verified, then written only through the existing flash pipeline.",
          "If the device is not already in BOOTSEL, it will restart as RPI-RP2 and you must Connect to Bootloader.",
          "",
          "Continue?",
        ];
  if (!window.confirm(confirmLines.join("\n"))) {
    shell.setStatus("Published firmware install cancelled.");
    return;
  }

  firmwareUpdateInFlight = true;
  pendingPreparedUpdate = null;
  refreshInstallEnabled();
  publishFirmwareUpdatePanel({
    status: FW_UPDATE_UI_PHASE.DOWNLOADING,
    current: session?.info?.firmware || fwCurrentVersion,
    userMessage: "Downloading update...",
    canInstall: false,
    manualBootloader: false,
  });
  shell.setBusy(true);
  shell.setStatus("Downloading and verifying published firmware…");

  try {
    const preparedResult = await prepareFirmwareUpdate(DEFAULT_FIRMWARE_MANIFEST_URL, {
      connected: Boolean(picobootSession),
      productId: picobootSession?.info?.productId ?? null,
    });
    if (!preparedResult.ok) {
      publishFirmwareUpdatePanel({
        status: FW_UPDATE_UI_PHASE.ERROR,
        detail: preparedResult.error,
        canInstall: false,
        manualBootloader: false,
      });
      shell.setStatus(preparedResult.error);
      firmwareUpdateInFlight = false;
      return;
    }

    pendingPreparedUpdate = preparedResult.prepared;
    appendFlashLog(
      `Prepared published UF2 ${pendingPreparedUpdate.fileName} sha256=${pendingPreparedUpdate.download.sha256.slice(0, 12)}…`
    );

    const currentForGate = session?.info?.firmware || fwCurrentVersion;
    const entry = resolveFirmwareBootloaderEntry({
      currentFirmware: currentForGate,
      minEnterBootloader:
        pendingPreparedUpdate.download.manifest.minDeviceFirmwareForEnterBootloader,
      hasPicobootRp2040: picobootSession?.info?.productId === 0x0003,
    });

    if (entry.action === "flash-now") {
      shell.setBusy(false);
      await flashPendingPreparedUpdate();
      return;
    }

    if (entry.action === "error") {
      publishFirmwareUpdatePanel({
        status: FW_UPDATE_UI_PHASE.ERROR,
        detail: entry.error,
        canInstall: false,
        manualBootloader: false,
      });
      shell.setStatus(entry.error);
      pendingPreparedUpdate = null;
      firmwareUpdateInFlight = false;
      return;
    }

    if (entry.action === "manual-bootsel") {
      bootloaderHandoff = true;
      bootloaderHandoffStatus = MANUAL_BOOTSEL_HANDOFF_STATUS;
      shell.setBusy(false);
      shell.setStatus(MANUAL_BOOTSEL_HANDOFF_STATUS);
      publishFirmwareUpdatePanel({
        status: FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
        latest: pendingPreparedUpdate.download.manifest.version,
        current: currentForGate,
        detail: null,
        canInstall: false,
        manualBootloader: true,
      });
      return;
    }

    // entry.action === "enter-bootloader"
    if (!session) {
      publishFirmwareUpdatePanel({
        status: FW_UPDATE_UI_PHASE.ERROR,
        detail: "MIDI session required to enter bootloader before flash.",
        canInstall: false,
        manualBootloader: false,
      });
      shell.setStatus("Connect the device over MIDI, or Connect to Bootloader first.");
      pendingPreparedUpdate = null;
      firmwareUpdateInFlight = false;
      return;
    }

    publishFirmwareUpdatePanel({
      status: FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
      latest: pendingPreparedUpdate.download.manifest.version,
      userMessage: "Preparing device...",
      canInstall: false,
      manualBootloader: false,
    });
    shell.setStatus("Verified UF2. Entering bootloader…");

    bootloaderHandoff = true;
    bootloaderHandoffStatus = BOOTLOADER_STATUS;
    try {
      await session.profile.enterBootloader(session.sysex);
    } catch (error) {
      if (!isDisconnectError(error)) {
        bootloaderHandoff = false;
        throw error;
      }
    }

    shell.setBusy(false);
    shell.setStatus(
      "UF2 verified. Device should be RPI-RP2 — press Connect to Bootloader to continue flashing."
    );
    publishFirmwareUpdatePanel({
      status: FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
      detail: null,
      canInstall: false,
      manualBootloader: false,
    });
  } catch (error) {
    pendingPreparedUpdate = null;
    firmwareUpdateInFlight = false;
    const message = error && error.message ? error.message : String(error);
    publishFirmwareUpdatePanel({
      status: FW_UPDATE_UI_PHASE.ERROR,
      detail: message,
      canInstall: false,
      manualBootloader: false,
    });
    fail(error);
  } finally {
    shell.setBusy(false);
    refreshInstallEnabled();
  }
}

async function readFromDevice(statusText = "Read current configuration.") {
  await withSession(async (connected) => {
    if (!connected.profile.capabilities.configReadWrite) {
      throw new Error(`${connected.profile.displayName} configuration read is not implemented.`);
    }
    const info = await connected.sysex.getInfo();
    const config = await connected.profile.readConfig(connected.sysex);
    shell.setConnected({ ...info, model: connected.profile.displayName });
    shell.setConfig(config);
    shell.setStatus(statusText);
  }, "Reading…");
}

shell.onConnect(async () => {
  shell.setBusy(true);
  shell.setStatus("Connecting…");
  try {
    dropSession();
    session = await connectMiniCube({
      onDisconnected() {
        session = null;
        showDisconnectedMp9Defaults();
        refreshInstallEnabled();
        if (bootloaderHandoff) {
          bootloaderHandoff = false;
          shell.setDisconnected(bootloaderHandoffStatus);
          return;
        }
        if (!firmwareUpdateInFlight) {
          resetFirmwareUpdatePanel();
        }
        shell.setDisconnected("Device disconnected.");
      },
    });
    mountProfile(session.profile);
    shell.setConnected(session.info);
    if (session.profile.capabilities.configReadWrite) {
      const config = await session.profile.readConfig(session.sysex);
      shell.setConfig(config);
      if (awaitMidiAfterReboot) {
        awaitMidiAfterReboot = false;
        const stored = acceptedFlash?.storedConfig;
        const channelMatch = stored?.ok && stored.midiChannel === config.midiChannel;
        const ccMatch =
          stored?.ok && stored.padCc && stored.padCc.every((value, index) => value === config.padCc[index]);
        const compare = stored?.ok
          ? `GET_CONFIG Channel ${config.midiChannel} / CC ${config.padCc.join(", ")}. Pre-update EEPROM probe Channel ${stored.midiChannel} / CC ${stored.padCc.join(", ")}. ${channelMatch && ccMatch ? "Channel/CC match the kept probe." : "Channel/CC differ from the kept EEPROM probe."}`
          : `GET_CONFIG Channel ${config.midiChannel} / CC ${config.padCc.join(", ")}. Pre-update EEPROM probe was not a valid StoredConfig.`;
        shell.setStatus(
          `GET_INFO firmware ${session.info.firmware}. ${compare}`
        );
        appendFlashLog(`MIDI reconnect: GET_INFO ${session.info.firmware}; ${compare}`);
      } else {
        shell.setStatus("Connected. Current configuration loaded.");
      }
      await checkPublishedFirmwareUpdate({ quiet: true });
    } else {
      shell.setStatus(
        `Identified ${session.profile.displayName}, but its configuration protocol is not implemented yet.`
      );
    }
  } catch (error) {
    dropSession();
    showDisconnectedMp9Defaults();
    shell.setDisconnected();
    refreshInstallEnabled();
    fail(error);
  } finally {
    shell.setBusy(false);
    refreshInstallEnabled();
  }
});

shell.onRead(() => readFromDevice());

shell.onCheckFirmware(() => {
  checkPublishedFirmwareUpdate({ quiet: false });
});

shell.onInstallFirmware(() => {
  installPublishedFirmwareUpdate();
});

shell.onSave(() =>
  withSession(async (connected) => {
    if (!connected.profile.capabilities.save) {
      throw new Error(`${connected.profile.displayName} save is not implemented.`);
    }
    const config = shell.getConfig();
    const error = connected.profile.validateConfig(config);
    if (error) {
      throw new Error(error);
    }
    await connected.profile.writeConfig(connected.sysex, config);
    await connected.profile.saveConfig(connected.sysex);
    const confirmed = await connected.profile.readConfig(connected.sysex);
    shell.setConfig(confirmed);
    shell.setStatus(`Saved to ${connected.profile.displayName}.`);
  }, "Saving…")
);

shell.onRestore(() =>
  withSession(async (connected) => {
    if (!connected.profile.capabilities.restore) {
      throw new Error(`${connected.profile.displayName} restore is not implemented.`);
    }
    await connected.profile.restoreDefaults(connected.sysex);
    const config = await connected.profile.readConfig(connected.sysex);
    shell.setConfig(config);
    shell.setStatus(`Restored defaults and saved them to ${connected.profile.displayName}.`);
  }, "Restoring defaults…")
);

shell.onFirmwareUpdate(async () => {
  if (!session) {
    shell.setStatus("Connect a device first.");
    return;
  }
  if (!window.confirm(FIRMWARE_UPDATE_CONFIRM)) {
    shell.setStatus("Firmware update cancelled.");
    return;
  }

  await withSession(async (connected) => {
    if (!connected.profile.capabilities.firmwareUpdate || !connected.profile.enterBootloader) {
      throw new Error(`${connected.profile.displayName} firmware update mode is not implemented.`);
    }
    bootloaderHandoff = true;
    try {
      await connected.profile.enterBootloader(connected.sysex);
      shell.setStatus(BOOTLOADER_STATUS);
    } catch (error) {
      if (isDisconnectError(error)) {
        shell.setStatus(BOOTLOADER_STATUS);
        return;
      }
      bootloaderHandoff = false;
      throw error;
    }
  }, "Entering firmware update mode…");
});

async function dropPicoboot(result = "Not connected") {
  if (stopPicobootUsbWatch) {
    stopPicobootUsbWatch();
    stopPicobootUsbWatch = null;
  }
  const device = picobootSession?.device;
  picobootSession = null;
  await releasePicoboot(device);
  showIdleBootloader(result);
  setFlashButtons({ write: false, reboot: false });
}

function watchNavigatorUsbDisconnect(device) {
  const usb = navigator.usb;
  if (!usb || typeof usb.addEventListener !== "function") {
    return () => {};
  }
  const onDisconnect = (event) => {
    if (event.device !== device) {
      return;
    }
    if (stopPicobootUsbWatch) {
      stopPicobootUsbWatch();
      stopPicobootUsbWatch = null;
    }
    picobootSession = null;
    showIdleBootloader("Disconnected");
    setFlashButtons({ write: false, reboot: false });
    shell.setPicobootProtocol(emptyPicobootProtocolInfo());
    refreshInstallEnabled();
    if (awaitMidiAfterReboot) {
      shell.setStatus(
        "BOOTSEL USB gone after reboot. Use Connect for GET_INFO / GET_CONFIG. Pre-update EEPROM probe is kept."
      );
    } else {
      shell.setStatus("Bootloader USB device disconnected.");
    }
  };
  usb.addEventListener("disconnect", onDisconnect);
  return () => usb.removeEventListener("disconnect", onDisconnect);
}

shell.onConnectBootloader(async () => {
  if (!isWebUsbSupported()) {
    showIdleBootloader("Failed: WebUSB is not available in this browser.");
    shell.setStatus("Connect to Bootloader needs Chrome or Edge on HTTPS or localhost.");
    return;
  }

  shell.setBusy(true);
  shell.setStatus("Select the RP2 Boot / PICOBOOT device in the browser dialog…");
  try {
    await dropPicoboot("Not connected");
    picobootSession = await requestAndClaimPicoboot();
    showPicobootInfo(picobootSession.info, "Connected (interface claimed, flash not written)");
    shell.setPicobootProtocol(emptyPicobootProtocolInfo());
    shell.setStatus(
      `WebUSB connected to ${picobootSession.info.chip} bootloader ${picobootSession.info.vidPid}. Flash was not written.`
    );
    try {
      stopPicobootUsbWatch = watchNavigatorUsbDisconnect(picobootSession.device);
    } catch (_error) {
      stopPicobootUsbWatch = null;
    }

    if (pendingPreparedUpdate && firmwareUpdateInFlight) {
      shell.setBusy(false);
      await flashPendingPreparedUpdate();
      return;
    }

    refreshInstallEnabled();
  } catch (error) {
    picobootSession = null;
    const dump = error && error.interfaceDump ? error.interfaceDump : "(not enumerated yet)";
    if (isUserCancelledUsb(error)) {
      showIdleBootloader("Cancelled", dump);
      shell.setStatus("Connect to Bootloader cancelled.");
    } else {
      const message = error && error.message ? error.message : String(error);
      showIdleBootloader(`Failed: ${message}`, dump);
      shell.setStatus(message);
    }
    if (pendingPreparedUpdate) {
      publishFirmwareUpdatePanel({
        status: FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
        detail: "Bootloader connect failed. Retry Connect to Bootloader to flash the prepared update.",
        canInstall: false,
      });
    }
  } finally {
    shell.setBusy(false);
    refreshInstallEnabled();
  }
});

shell.onDisconnectBootloader(async () => {
  shell.setBusy(true);
  try {
    await dropPicoboot("Not connected");
    shell.setStatus("Bootloader WebUSB released. Flash was not written.");
  } catch (error) {
    fail(error);
  } finally {
    shell.setBusy(false);
  }
});

shell.onTestPicoboot(async () => {
  if (!picobootSession) {
    shell.setStatus("Connect to Bootloader first.");
    return;
  }

  shell.setBusy(true);
  shell.setStatus("Testing PICOBOOT communication (PC_READ of RP2040 ROM vector table)…");
  shell.setPicobootProtocol({
    commandName: "PC_READ",
    commandStatus: "in progress",
    response: "—",
    transferredBytes: "—",
    protocolError: "—",
  });
  try {
    const result = await testPicobootCommunication(picobootSession);
    shell.setPicobootProtocol(result);
    showPicobootInfo(
      picobootSession.info,
      "PICOBOOT communication OK (PC_READ ROM, flash not written)"
    );
    shell.setStatus(
      `PICOBOOT PC_READ succeeded: ${result.transferredBytes} bytes from RP2040 ROM, ${result.commandStatus}. Flash was not written.`
    );
  } catch (error) {
    shell.setPicobootProtocol(protocolInfoFromError(error));
    const message = error && error.message ? error.message : String(error);
    shell.setStatus(message);
  } finally {
    shell.setBusy(false);
  }
});

function skippedEepromText() {
  return "Bootloader not connected. EEPROM was not read. Connect to Bootloader, then Analyze UF2 (Dry Run) for a non-destructive PC_READ of 256 bytes at 0x101FF000. Flash is not modified.";
}

function formatHexPreview(bytes, length = 32) {
  const slice = bytes.subarray(0, length);
  const hex = Array.from(slice, (value) => value.toString(16).toUpperCase().padStart(2, "0")).join(" ");
  return bytes.length > length ? `${hex} … (${bytes.length} bytes)` : hex;
}

async function probeEepromIfConnected() {
  if (!picobootSession) {
    return { text: skippedEepromText(), protocol: null, payload: null, stored: null };
  }

  const result = await readEepromProbe(picobootSession);
  const stored = parseStoredConfig(result.payload);
  const text = [
    "=== Pre-update EEPROM probe (kept across Write UF2) ===",
    formatStoredConfig(stored, {
      note: `${DRY_RUN_BANNER}. EEPROM PC_READ only — this sector is outside the accepted erase range.`,
      commandLine: `${result.commandName}; ${result.commandStatus}; ${result.transferredBytes} bytes`,
      hex: formatHexPreview(result.payload, 32),
    }),
  ].join("\n");
  return {
    text,
    payload: result.payload,
    stored,
    protocol: {
      commandName: result.commandName,
      commandStatus: result.commandStatus,
      response: `EEPROM[0x101FF000] ${result.transferredBytes} bytes\n${formatHexPreview(result.payload, 32)}`,
      transferredBytes: result.transferredBytes,
      protocolError: "—",
    },
  };
}

function writeConfirmText(plan, fileName) {
  return [
    "Write this Dry Run ACCEPT plan to flash?",
    "",
    `File: ${fileName}`,
    `Erase: ${plan.eraseSectors} × 4 KiB  ${plan.eraseRangeText}`,
    `Write: ${plan.payloadPageCount} pages / ${plan.writeBytes} bytes`,
    `Write range: ${plan.writeRangeText}`,
    `EEPROM ${plan.eepromRangeText} will not be erased or written.`,
    "",
    "Verify is byte-for-byte on every page. Reboot stays disabled until verify passes.",
    "On erase/write/verify failure the device stays in BOOTSEL.",
    "",
    "Continue?",
  ].join("\n");
}

async function runUf2DryRun() {
  const file = shell.getUf2File();
  if (!file) {
    clearAcceptedFlash();
    shell.setFlashPlan(emptyFlashPlanView());
    shell.setStatus("Select a known-good MP9 UF2 first. Flash was not modified.");
    return;
  }

  verifyTicket = null;
  setFlashButtons({ write: false, reboot: false });

  shell.setBusy(true);
  shell.setStatus(`Dry Run: parsing ${file.name} in the browser…`);
  shell.setFlashPlan({
    banner: DRY_RUN_BANNER,
    summary: `Parsing ${file.name}…\nFlash is not modified.`,
    eeprom: picobootSession ? "Reading EEPROM[0x101FF000] (PC_READ)…" : skippedEepromText(),
  });

  try {
    const buffer = await file.arrayBuffer();
    const plan = buildFlashPlan(buffer, {
      connected: Boolean(picobootSession),
      productId: picobootSession?.info?.productId,
    });
    const summary = formatFlashPlan(plan, file.name);

    let eepromText = skippedEepromText();
    let eepromBytes = null;
    let stored = null;
    try {
      const probe = await probeEepromIfConnected();
      eepromText = probe.text;
      eepromBytes = probe.payload;
      stored = probe.stored;
      if (probe.protocol) {
        shell.setPicobootProtocol(probe.protocol);
        showPicobootInfo(picobootSession.info, "Dry Run EEPROM PC_READ OK (flash not written)");
      }
    } catch (error) {
      const protocol = protocolInfoFromError(error);
      shell.setPicobootProtocol(protocol);
      eepromText = [
        DRY_RUN_BANNER,
        "EEPROM PC_READ failed. Flash was not erased or written. Write UF2 stays disabled.",
        protocol.protocolError,
      ].join("\n");
    }

    const writable = canAcceptForWrite(plan, file, eepromBytes);
    acceptedFlash = writable
      ? {
          fileName: file.name,
          identity: fileIdentity(file),
          plan,
          eepromBytes,
          eepromText,
          storedConfig: stored,
        }
      : null;
    setFlashButtons({ write: writable, reboot: false });

    shell.setFlashPlan({
      banner: DRY_RUN_BANNER,
      summary,
      eeprom: eepromText,
    });
    if (writable) {
      shell.setStatus(
        `Dry Run ACCEPT for ${file.name}. Write UF2 will erase ${plan.eraseSectors} sectors and program ${plan.payloadPageCount} pages. EEPROM is not in range.`
      );
      appendFlashLog(
        `Dry Run ACCEPT ${file.name}: erase ${plan.eraseSectors} sectors, write ${plan.payloadPageCount} pages, EEPROM overlap none.`
      );
    } else if (plan.ok && file.name !== KNOWN_MP9_UF2_FILENAME) {
      shell.setStatus(
        `Dry Run passed, but this PoC only programs ${KNOWN_MP9_UF2_FILENAME}. Flash was not modified.`
      );
    } else if (plan.ok) {
      shell.setStatus(
        `Dry Run complete for ${file.name}: validations passed. Connect to Bootloader and keep a successful EEPROM probe before Write UF2. Flash was not modified.`
      );
    } else {
      shell.setStatus(`Dry Run complete for ${file.name}: UF2 would be rejected before erase. Flash was not modified.`);
    }
  } catch (error) {
    clearAcceptedFlash({ keepLog: true });
    const message = error && error.message ? error.message : String(error);
    let eepromText = skippedEepromText();
    try {
      const probe = await probeEepromIfConnected();
      eepromText = probe.text;
      if (probe.protocol) {
        shell.setPicobootProtocol(probe.protocol);
      }
    } catch (probeError) {
      eepromText = [
        DRY_RUN_BANNER,
        "EEPROM PC_READ failed. Flash was not erased or written.",
        probeError && probeError.message ? probeError.message : String(probeError),
      ].join("\n");
    }
    shell.setFlashPlan({
      banner: DRY_RUN_BANNER,
      summary: `Failed to parse UF2.\n${message}\nFlash was not modified.`,
      eeprom: eepromText,
    });
    shell.setStatus(message);
  } finally {
    shell.setBusy(false);
  }
}

shell.onUf2FileChange(() => {
  runUf2DryRun();
});

shell.onUf2DryRun(() => {
  runUf2DryRun();
});

shell.onFlashWrite(async () => {
  const file = shell.getUf2File();
  if (!picobootSession) {
    shell.setStatus("Connect to Bootloader first.");
    return;
  }
  if (!acceptedFlash?.plan || !file) {
    shell.setStatus("Run Analyze UF2 (Dry Run) until ACCEPT before Write UF2.");
    return;
  }
  if (!sameFileIdentity(acceptedFlash.identity, fileIdentity(file))) {
    shell.setStatus("UF2 file changed after Dry Run. Re-run Analyze UF2 (Dry Run).");
    setFlashButtons({ write: false, reboot: false });
    return;
  }
  if (!window.confirm(writeConfirmText(acceptedFlash.plan, file.name))) {
    shell.setStatus("Write UF2 cancelled. Flash was not modified.");
    return;
  }

  verifyTicket = null;
  setFlashButtons({ write: false, reboot: false });
  shell.setBusy(true);
  shell.setStatus("Writing accepted Dry Run plan (erase + write + verify). Reboot is still forbidden.");
  shell.setFlashPlan({
    banner: FLASH_WRITE_BANNER,
    summary: formatFlashPlan(acceptedFlash.plan, file.name),
    eeprom: acceptedFlash.eepromText,
  });

  try {
    const buffer = await file.arrayBuffer();
    const livePlan = buildFlashPlan(buffer, {
      connected: true,
      productId: picobootSession.info?.productId,
    });
    const result = await programAcceptedFlashPlan(
      picobootSession,
      {
        plan: acceptedFlash.plan,
        livePlan,
        fileName: file.name,
        eepromBytes: acceptedFlash.eepromBytes,
      },
      {
        onProgress(event) {
          const line = `${event.phase}: ${event.commandName} ${event.detail || ""} ${event.total ? `(${event.current}/${event.total})` : ""}`.trim();
          appendFlashLog(line);
          shell.setPicobootProtocol({
            commandName: event.commandName,
            commandStatus: event.phase,
            response: event.detail || "—",
            transferredBytes: event.current != null ? String(event.current) : "—",
            protocolError: "—",
          });
          if (event.phase === "write" || event.phase === "verify") {
            shell.setStatus(
              `${event.phase} ${event.current}/${event.total} at ${event.detail}. Reboot still forbidden.`
            );
          } else {
            shell.setStatus(`${event.phase}: ${event.detail || event.commandName}. Reboot still forbidden.`);
          }
        },
      }
    );
    verifyTicket = result.ticket;
    setFlashButtons({ write: true, reboot: true });
    showPicobootInfo(picobootSession.info, "Verify PASS — EEPROM unchanged, reboot allowed");
    shell.setPicobootProtocol({
      commandName: "verify",
      commandStatus: "PASS",
      response: `${result.pageCount} pages matched UF2 payload. EEPROM unchanged. Reboot is now allowed.`,
      transferredBytes: String(result.writeBytes),
      protocolError: "—",
    });
    appendFlashLog(
      `VERIFY PASS: ${result.pageCount} pages, ${result.eraseSectors} sectors erased, EEPROM unchanged. Reboot allowed.`
    );
    shell.setStatus(
      `Verify PASS for ${file.name}. ${result.pageCount} pages matched. EEPROM unchanged. Reboot is now enabled. Device is still in BOOTSEL.`
    );
  } catch (error) {
    verifyTicket = null;
    setFlashButtons({ write: Boolean(acceptedFlash), reboot: false });
    const protocol = protocolInfoFromError(error);
    shell.setPicobootProtocol(protocol);
    appendFlashLog(`FAIL: ${protocol.protocolError} — staying in BOOTSEL, reboot not sent.`);
    const message = error && error.message ? error.message : String(error);
    shell.setStatus(`${message} Device stays in BOOTSEL. Reboot was not sent.`);
    if (acceptedFlash?.eepromText) {
      shell.setFlashPlan({
        banner: FLASH_WRITE_BANNER,
        summary: formatFlashPlan(acceptedFlash.plan, file.name),
        eeprom: acceptedFlash.eepromText,
      });
    }
  } finally {
    shell.setBusy(false);
  }
});

shell.onFlashReboot(async () => {
  if (!picobootSession) {
    shell.setStatus("Connect to Bootloader first.");
    return;
  }
  if (!verifyTicket?.rebootAllowed) {
    shell.setStatus("Reboot is forbidden until verify passes.");
    return;
  }
  if (
    !window.confirm(
      [
        "Verify passed. Reboot out of BOOTSEL into the new firmware?",
        "",
        "Then use Connect for GET_INFO and GET_CONFIG.",
        "The pre-update EEPROM probe stays on this page for comparison.",
        "",
        "Continue?",
      ].join("\n")
    )
  ) {
    shell.setStatus("Reboot cancelled. Device is still in BOOTSEL.");
    return;
  }

  shell.setBusy(true);
  shell.setStatus("Sending PC_REBOOT after verify…");
  try {
    const result = await rebootAfterVerifiedFlash(picobootSession, verifyTicket);
    awaitMidiAfterReboot = true;
    verifyTicket = null;
    setFlashButtons({ write: false, reboot: false });
    shell.setPicobootProtocol(result);
    appendFlashLog("PC_REBOOT issued after verify. Waiting for MIDI Connect / GET_INFO / GET_CONFIG.");
    shell.setStatus(
      "PC_REBOOT sent. When MP9 enumerates as MIDI, press Connect for GET_INFO and GET_CONFIG. Pre-update EEPROM probe is kept."
    );
  } catch (error) {
    const protocol = protocolInfoFromError(error);
    shell.setPicobootProtocol(protocol);
    appendFlashLog(`Reboot failed: ${protocol.protocolError} — staying in BOOTSEL.`);
    shell.setStatus(`${protocol.protocolError} Device stays in BOOTSEL.`);
  } finally {
    shell.setBusy(false);
  }
});

showDisconnectedMp9Defaults();
shell.setDisconnected();
shell.setWebUsbAvailable(isWebUsbSupported());
showIdleBootloader(isWebUsbSupported() ? "Not connected" : "Failed: WebUSB is not available");
shell.setFlashPlan(emptyFlashPlanView());
shell.setFlashProgramLog("");
setFlashButtons({ write: false, reboot: false });
shell.setStatus("Connect a mini cube device. MP9 is the first supported model. Analyze UF2 (Dry Run) before Write UF2.");
