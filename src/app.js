import {
  buildFlashPlan,
  DRY_RUN_BANNER,
  FLASH_WRITE_BANNER,
  emptyFlashPlanView,
  formatFlashPlan,
  formatStoredConfig,
  isKnownProgrammableUf2Name,
  parseStoredConfig,
} from "./flashPlan.js";
import { programAcceptedFlashPlan, rebootAfterVerifiedFlash } from "./flashProgram.js";
import { fetchFirmwareManifest } from "./firmwareDist.js";
import { prepareFirmwareUpdate } from "./firmwareUpdate.js";
import {
  FW_UPDATE_UI_PHASE,
  PRODUCT_CONTINUE_GUIDANCE,
  PRODUCT_ENTERING_UPDATE_MODE_GUIDANCE,
  PRODUCT_PREPARING_GUIDANCE,
  PRODUCT_RECONNECTING_GUIDANCE,
  PRODUCT_RESTARTING_GUIDANCE,
  PRODUCT_SELECT_RP2_GUIDANCE,
  PRODUCT_USB_CANCELLED_GUIDANCE,
  PRODUCT_WRITING_PANEL_MESSAGE,
  canStartFirmwareFlash,
  canStartFirmwareInstall,
  connectedStatusMessage,
  evaluateUpdateCheck,
  firmwareManifestUrlForProfile,
  firmwareUpdateFlashProgressMessage,
  firmwareUpdateSuccessMessage,
  firmwareUpdateUserFacingDetail,
  formatFirmwareUpdatePhase,
  resolveFirmwareBootloaderEntry,
} from "./firmwareUpdateUi.js";
import { connectMiniCube, MultipleMiniCubesError } from "./discovery.js";
import { formatLiveMidi, MidiConnection, midiSysexPermissionState, parseControlChange } from "./midi.js";
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

/** Legacy hidden ENTER_BOOTLOADER / Firmware Update button handoff (debug panel path). */
const BOOTLOADER_STATUS =
  "Device is in Firmware Update Mode. A USB drive named RPI-RP2 should appear. Next: Connect to Bootloader, then Analyze UF2 (Dry Run). Write UF2 stays off until Dry Run ACCEPT.";

const MF5_ENTER_BOOTLOADER_STATUS =
  "ENTER_BOOTLOADER ACK received. MF5 should appear as RPI-RP2 (PICOBOOT). MIDI disconnect is expected.";

/** Product Firmware Update panel — waiting for the Continue (WebUSB) gesture. */
const PRODUCT_CONTINUE_STATUS = PRODUCT_CONTINUE_GUIDANCE;

const MANUAL_BOOTSEL_HANDOFF_STATUS =
  "Hold BOOTSEL while reconnecting USB, then click Continue and select RP2 Boot.";

const FIRMWARE_UPDATE_CONFIRM = [
  "Enter Firmware Update Mode?",
  "",
  "The device will restart as a USB drive named RPI-RP2. MIDI will disconnect.",
  "After that you can use Connect to Bootloader, Analyze UF2 (Dry Run), then Write UF2 (erase + verify).",
  "Reboot stays disabled until every page verifies. EEPROM is not in the erase range.",
  "",
  "Continue?",
].join("\n");

function publishedInstallConfirm(current, latest, manualBootsel) {
  if (manualBootsel) {
    return [
      `Install firmware ${latest}?`,
      "",
      "This older firmware cannot enter update mode automatically.",
      "After preparing the update, hold BOOTSEL while reconnecting USB, then press Continue.",
      "Your settings will be kept.",
    ].join("\n");
  }
  return [
    `Install firmware ${latest}?`,
    "",
    "Your settings will be kept.",
  ].join("\n");
}

function publishFirmwareError(detail, extras = {}) {
  const raw = detail == null ? "" : String(detail).trim();
  if (raw) {
    // Keep technical detail out of the normal UI, but preserve it for debugging.
    console.warn("[Firmware Update]", raw);
    appendFlashLog(`Firmware Update error: ${raw}`);
  }
  publishFirmwareUpdatePanel({
    ...extras,
    status: FW_UPDATE_UI_PHASE.ERROR,
    detail: firmwareUpdateUserFacingDetail(detail),
    canInstall: false,
  });
  // Panel owns update errors; keep global Status for normal product ops.
  shell.setStatus("");
}

function configCcList(config) {
  if (Array.isArray(config?.faderCc)) {
    return config.faderCc;
  }
  if (Array.isArray(config?.padCc)) {
    return config.padCc;
  }
  return null;
}

function storedCcList(stored) {
  if (Array.isArray(stored?.cc)) {
    return stored.cc;
  }
  if (Array.isArray(stored?.faderCc)) {
    return stored.faderCc;
  }
  if (Array.isArray(stored?.padCc)) {
    return stored.padCc;
  }
  return null;
}

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
let bootloaderHandoffStatus = PRODUCT_CONTINUE_STATUS;

/** Kept after unplug so statechange can auto-reconnect without a new permission prompt. */
let midiAccessHolder = null;
let autoConnectTimer = null;
let autoConnectInFlight = false;
let connectEpoch = 0;

const AUTO_CONNECT_DEBOUNCE_MS = 450;

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
    isKnownProgrammableUf2Name(file?.name) &&
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

function dropSession({ keepAccess = false } = {}) {
  if (session?.midi) {
    if (keepAccess) {
      session.midi.releaseSession();
      armMidiAccessWatch(session.midi);
    } else {
      session.midi.close();
      if (midiAccessHolder === session.midi) {
        midiAccessHolder = null;
      }
    }
  }
  session = null;
  shell.setLiveMidi("—");
}

function armMidiAccessWatch(midi) {
  if (!midi?.access) {
    return;
  }
  midiAccessHolder = midi;
  midi.onPortStateChange(() => {
    scheduleAutoConnect("port-statechange");
  });
}

function shouldAttemptAutoConnect() {
  if (session || autoConnectInFlight) {
    return false;
  }
  if (picobootSession) {
    return false;
  }
  // During ENTER_BOOTLOADER / flash, MIDI is expected to disappear. After reboot
  // we set awaitMidiAfterReboot and want auto reconnect.
  if (firmwareUpdateInFlight && !awaitMidiAfterReboot) {
    return false;
  }
  if (bootloaderHandoff && !awaitMidiAfterReboot) {
    return false;
  }
  return true;
}

function scheduleAutoConnect(reason = "scheduled") {
  if (!shouldAttemptAutoConnect()) {
    return;
  }
  if (autoConnectTimer) {
    clearTimeout(autoConnectTimer);
  }
  autoConnectTimer = setTimeout(() => {
    autoConnectTimer = null;
    tryAutoConnect({ reason, quiet: true });
  }, AUTO_CONNECT_DEBOUNCE_MS);
}

function handleSessionDisconnected() {
  const wasAwaitingReboot = awaitMidiAfterReboot;
  session = null;
  showDisconnectedEmpty();
  refreshInstallEnabled();

  if (bootloaderHandoff) {
    bootloaderHandoff = false;
    publishFirmwareUpdatePanel({
      status: FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
      userMessage: bootloaderHandoffStatus,
      canInstall: false,
    });
    shell.setDisconnected("");
    // Keep watching; MIDI returns after flash reboot or if user cancels.
    scheduleAutoConnect("bootloader-handoff");
    return;
  }

  if (!firmwareUpdateInFlight) {
    resetFirmwareUpdatePanel();
  }

  if (wasAwaitingReboot) {
    publishFirmwareUpdatePanel({
      status: FW_UPDATE_UI_PHASE.FLASHING,
      userMessage: PRODUCT_RECONNECTING_GUIDANCE,
      canInstall: false,
    });
    shell.setDisconnected("");
  } else {
    shell.setDisconnected("Disconnected");
  }
  scheduleAutoConnect("disconnect");
}

async function establishSession(connected, { statusMode = "normal" } = {}) {
  session = connected;
  armMidiAccessWatch(connected.midi);
  attachLiveMidiMonitor(session.midi);
  mountProfile(session.profile);
  shell.setConnected(session.info);

  if (session.profile.capabilities.configReadWrite) {
    const config = await session.profile.readConfig(session.sysex);
    shell.setConfig(config);
    if (awaitMidiAfterReboot || statusMode === "after-reboot") {
      awaitMidiAfterReboot = false;
      const stored = acceptedFlash?.storedConfig;
      const configCc = configCcList(config);
      const storedCc = storedCcList(stored);
      const channelMatch = stored?.ok && stored.midiChannel === config.midiChannel;
      const ccMatch =
        stored?.ok &&
        Array.isArray(storedCc) &&
        Array.isArray(configCc) &&
        storedCc.length === configCc.length &&
        storedCc.every((value, index) => value === configCc[index]);
      const configCcText = Array.isArray(configCc) ? configCc.join(", ") : "(none)";
      const storedCcText = Array.isArray(storedCc) ? storedCc.join(", ") : "(none)";
      const compare = stored?.ok
        ? `GET_CONFIG Channel ${config.midiChannel} / CC ${configCcText}. Pre-update EEPROM probe Channel ${stored.midiChannel} / CC ${storedCcText}. ${channelMatch && ccMatch ? "Channel/CC match the kept probe." : "Channel/CC differ from the kept EEPROM probe."}`
        : `GET_CONFIG Channel ${config.midiChannel} / CC ${configCcText}. Pre-update EEPROM probe was not a valid StoredConfig.`;
      appendFlashLog(`MIDI reconnect: GET_INFO ${session.info.firmware}; ${compare}`);
      const version = session.info.firmware;
      const successMessage = firmwareUpdateSuccessMessage(version);
      shell.setStatus(connectedStatusMessage(session.profile));
      await checkPublishedFirmwareUpdate({ quiet: true });
      // Quiet check may set UP_TO_DATE; keep post-update success as the panel primary.
      publishFirmwareUpdatePanel({
        status: FW_UPDATE_UI_PHASE.SUCCESS,
        current: version,
        latest: fwLatestVersion || version,
        userMessage: successMessage,
        canInstall: false,
      });
    } else if (statusMode === "auto") {
      shell.setStatus(connectedStatusMessage(session.profile));
      await checkPublishedFirmwareUpdate({ quiet: true });
    } else {
      shell.setStatus(connectedStatusMessage(session.profile));
      await checkPublishedFirmwareUpdate({ quiet: true });
    }
  } else {
    shell.setStatus(
      `${session.profile.displayName} connected — settings are not available yet.`
    );
  }
}

async function ensureMidiAccessHolder() {
  if (midiAccessHolder?.access) {
    return midiAccessHolder;
  }
  const midi = new MidiConnection();
  await midi.requestAccess();
  armMidiAccessWatch(midi);
  return midi;
}

async function tryAutoConnect({ reason = "auto", quiet = true } = {}) {
  if (!shouldAttemptAutoConnect()) {
    return false;
  }

  autoConnectInFlight = true;
  const epoch = ++connectEpoch;
  shell.setBusy(true);
  if (!quiet) {
    shell.setStatus("Looking for your mini cube…");
  }

  try {
    const midi = await ensureMidiAccessHolder();
    if (epoch !== connectEpoch) {
      return false;
    }
    const connected = await connectMiniCube({
      requireUnique: true,
      midi,
      onDisconnected: handleSessionDisconnected,
    });
    if (epoch !== connectEpoch) {
      connected.midi.releaseSession();
      armMidiAccessWatch(connected.midi);
      return false;
    }
    midiAccessHolder = connected.midi;
    const statusMode = awaitMidiAfterReboot ? "after-reboot" : "auto";
    await establishSession(connected, { statusMode });
    return true;
  } catch (error) {
    if (epoch !== connectEpoch) {
      return false;
    }
    if (error instanceof MultipleMiniCubesError) {
      showDisconnectedEmpty();
      shell.setDisconnected(error.message);
      refreshInstallEnabled();
      return false;
    }
    // No device yet (replug in progress, BOOTSEL, etc.) — stay quiet.
    if (!quiet) {
      fail(error);
    } else if (reason === "load") {
      shell.setStatus("Connect a mini cube to get started.");
    }
    return false;
  } finally {
    autoConnectInFlight = false;
    if (epoch === connectEpoch) {
      shell.setBusy(false);
    }
    refreshInstallEnabled();
  }
}

async function connectFromUserGesture() {
  connectEpoch += 1;
  const epoch = connectEpoch;
  shell.setBusy(true);
  shell.setStatus("Connecting…");
  try {
    dropSession({ keepAccess: true });
    const midi = await ensureMidiAccessHolder();
    if (epoch !== connectEpoch) {
      return;
    }
    const connected = await connectMiniCube({
      requireUnique: false,
      midi,
      onDisconnected: handleSessionDisconnected,
    });
    if (epoch !== connectEpoch) {
      connected.midi.releaseSession();
      armMidiAccessWatch(connected.midi);
      return;
    }
    midiAccessHolder = connected.midi;
    const statusMode = awaitMidiAfterReboot ? "after-reboot" : "normal";
    await establishSession(connected, { statusMode });
  } catch (error) {
    if (epoch !== connectEpoch) {
      return;
    }
    showDisconnectedEmpty();
    shell.setDisconnected();
    refreshInstallEnabled();
    fail(error);
  } finally {
    shell.setBusy(false);
    refreshInstallEnabled();
  }
}

function onLiveMidiMessage(data) {
  const ccMessage = parseControlChange(data);
  if (!ccMessage) {
    return;
  }
  shell.setLiveMidi(formatLiveMidi(ccMessage));
  shell.highlightLiveMidiMatch(ccMessage);
}

function attachLiveMidiMonitor(midi) {
  midi.addMessageListener(onLiveMidiMessage);
}

function mountProfile(profile) {
  shell.clearDeviceView();
  const view = profile.mount(shell.deviceRoot);
  shell.setDeviceView(view, profile.capabilities);
  return view;
}

function showDisconnectedEmpty() {
  shell.clearDeviceView();
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
  if (!session?.profile?.capabilities?.firmwareUpdate) {
    resetFirmwareUpdatePanel();
    if (!quiet) {
      shell.setStatus(
        session?.profile
          ? `${session.profile.displayName} does not support firmware update yet.`
          : "Connect a device first."
      );
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
    // Panel owns update progress; keep Status as the normal connection state.
    shell.setStatus(connectedStatusMessage(session.profile));
  }

  const manifestUrl = firmwareManifestUrlForProfile(session.profile);
  const fetched = await fetchFirmwareManifest(manifestUrl);
  if (!fetched.ok) {
    publishFirmwareError(fetched.error, { latest: null, current: session.info.firmware });
    if (!quiet && session?.profile) {
      shell.setStatus(connectedStatusMessage(session.profile));
    }
    return;
  }

  if (fetched.manifest.device !== session.profile.displayName) {
    publishFirmwareError(
      `Manifest device ${JSON.stringify(fetched.manifest.device)} does not match ${session.profile.displayName}.`,
      { latest: null, current: session.info.firmware }
    );
    if (!quiet) {
      shell.setStatus(connectedStatusMessage(session.profile));
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
    shell.setStatus(connectedStatusMessage(session.profile));
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
    publishFirmwareError(
      "Bootloader session (RP2040 PID 0x0003) and a prepared update are required before flash."
    );
    firmwareUpdateInFlight = false;
    refreshInstallEnabled();
    return;
  }

  const prepared = pendingPreparedUpdate;
  publishFirmwareUpdatePanel({
    status: FW_UPDATE_UI_PHASE.FLASHING,
    userMessage: PRODUCT_WRITING_PANEL_MESSAGE,
    canInstall: false,
  });
  shell.setBusy(true);
  shell.setStatus("");
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
          const progressMessage = firmwareUpdateFlashProgressMessage(event.phase);
          publishFirmwareUpdatePanel({
            status: FW_UPDATE_UI_PHASE.FLASHING,
            userMessage: progressMessage,
            canInstall: false,
          });
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
      userMessage: PRODUCT_RESTARTING_GUIDANCE,
      canInstall: false,
    });
    const rebootResult = await rebootAfterVerifiedFlash(picobootSession, verifyTicket);
    awaitMidiAfterReboot = true;
    verifyTicket = null;
    setFlashButtons({ write: false, reboot: false });
    shell.setPicobootProtocol(rebootResult);
    pendingPreparedUpdate = null;
    const version = prepared.download.manifest.version;
    publishFirmwareUpdatePanel({
      status: FW_UPDATE_UI_PHASE.FLASHING,
      latest: version,
      userMessage: PRODUCT_RECONNECTING_GUIDANCE,
      detail: null,
      canInstall: false,
    });
    shell.setStatus("");
    scheduleAutoConnect("firmware-reboot");
  } catch (error) {
    verifyTicket = null;
    setFlashButtons({ write: false, reboot: false });
    const protocol = protocolInfoFromError(error);
    shell.setPicobootProtocol(protocol);
    const message = error && error.message ? error.message : String(error);
    appendFlashLog(`Published update FAIL: ${message}`);
    publishFirmwareError(message);
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
  if (
    !window.confirm(
      publishedInstallConfirm(current, latest, previewEntry.action === "manual-bootsel")
    )
  ) {
    shell.setStatus("Update cancelled.");
    return;
  }

  firmwareUpdateInFlight = true;
  pendingPreparedUpdate = null;
  refreshInstallEnabled();
  publishFirmwareUpdatePanel({
    status: FW_UPDATE_UI_PHASE.DOWNLOADING,
    current: session?.info?.firmware || fwCurrentVersion,
    userMessage: PRODUCT_PREPARING_GUIDANCE,
    canInstall: false,
    manualBootloader: false,
  });
  shell.setBusy(true);
  shell.setStatus("");

  try {
    const manifestUrl = firmwareManifestUrlForProfile(session?.profile);
    const preparedResult = await prepareFirmwareUpdate(manifestUrl, {
      connected: Boolean(picobootSession),
      productId: picobootSession?.info?.productId ?? null,
    });
    if (!preparedResult.ok) {
      publishFirmwareError(preparedResult.error);
      firmwareUpdateInFlight = false;
      return;
    }

    if (
      session?.profile?.displayName &&
      preparedResult.prepared.download.manifest.device !== session.profile.displayName
    ) {
      publishFirmwareError(
        `Manifest device ${JSON.stringify(preparedResult.prepared.download.manifest.device)} does not match ${session.profile.displayName}.`
      );
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
      publishFirmwareError(entry.error);
      pendingPreparedUpdate = null;
      firmwareUpdateInFlight = false;
      return;
    }

    if (entry.action === "manual-bootsel") {
      bootloaderHandoff = true;
      bootloaderHandoffStatus = MANUAL_BOOTSEL_HANDOFF_STATUS;
      shell.setBusy(false);
      shell.setStatus("");
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
      publishFirmwareError("MIDI session required to enter bootloader before flash.");
      pendingPreparedUpdate = null;
      firmwareUpdateInFlight = false;
      return;
    }

    publishFirmwareUpdatePanel({
      status: FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
      latest: pendingPreparedUpdate.download.manifest.version,
      userMessage: PRODUCT_ENTERING_UPDATE_MODE_GUIDANCE,
      canInstall: false,
      manualBootloader: false,
    });
    shell.setStatus("");

    bootloaderHandoff = true;
    bootloaderHandoffStatus = PRODUCT_CONTINUE_STATUS;
    try {
      await session.profile.enterBootloader(session.sysex);
    } catch (error) {
      if (!isDisconnectError(error)) {
        bootloaderHandoff = false;
        throw error;
      }
    }

    shell.setBusy(false);
    shell.setStatus("");
    publishFirmwareUpdatePanel({
      status: FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
      userMessage: PRODUCT_CONTINUE_STATUS,
      detail: null,
      canInstall: false,
      manualBootloader: false,
    });
  } catch (error) {
    pendingPreparedUpdate = null;
    firmwareUpdateInFlight = false;
    const message = error && error.message ? error.message : String(error);
    publishFirmwareError(message);
  } finally {
    shell.setBusy(false);
    refreshInstallEnabled();
  }
}

async function readFromDevice(statusText = "Settings loaded") {
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

shell.onConnect(() => connectFromUserGesture());

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
    shell.setStatus("Settings saved");
  }, "Saving…")
);

shell.onRestore(() =>
  withSession(async (connected) => {
    if (!connected.profile.capabilities.restore) {
      throw new Error(`${connected.profile.displayName} restore is not implemented.`);
    }
    if (
      !window.confirm("Restore factory defaults and save them to the device?")
    ) {
      shell.setStatus("Restore cancelled.");
      return;
    }
    await connected.profile.restoreDefaults(connected.sysex);
    const config = await connected.profile.readConfig(connected.sysex);
    shell.setConfig(config);
    shell.setStatus("Defaults restored");
  }, "Restoring defaults…")
);

shell.onEnterBootloader(async () => {
  if (!session) {
    shell.setStatus("Connect a device first.");
    return;
  }

  await withSession(async (connected) => {
    if (
      !connected.profile.capabilities.enterBootloader ||
      typeof connected.profile.enterBootloader !== "function"
    ) {
      throw new Error(`${connected.profile.displayName} ENTER_BOOTLOADER is not implemented.`);
    }
    bootloaderHandoff = true;
    bootloaderHandoffStatus = MF5_ENTER_BOOTLOADER_STATUS;
    try {
      await connected.profile.enterBootloader(connected.sysex);
      shell.setStatus(MF5_ENTER_BOOTLOADER_STATUS);
    } catch (error) {
      if (isDisconnectError(error)) {
        shell.setStatus(MF5_ENTER_BOOTLOADER_STATUS);
        return;
      }
      bootloaderHandoff = false;
      throw error;
    }
  }, "Sending ENTER_BOOTLOADER…");
});

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
      publishFirmwareUpdatePanel({
        status: FW_UPDATE_UI_PHASE.FLASHING,
        userMessage: PRODUCT_RECONNECTING_GUIDANCE,
        canInstall: false,
      });
      shell.setStatus("");
    } else if (pendingPreparedUpdate && firmwareUpdateInFlight) {
      shell.setStatus("");
      publishFirmwareUpdatePanel({
        status: FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
        userMessage: PRODUCT_CONTINUE_STATUS,
        canInstall: false,
      });
    } else {
      shell.setStatus("Disconnected");
    }
  };
  usb.addEventListener("disconnect", onDisconnect);
  return () => usb.removeEventListener("disconnect", onDisconnect);
}

shell.onConnectBootloader(async () => {
  if (!isWebUsbSupported()) {
    showIdleBootloader("Failed: WebUSB is not available in this browser.");
    shell.setStatus("Use Chrome or Edge to update firmware.");
    return;
  }

  shell.setBusy(true);
  const waitingForPreparedFlash = Boolean(pendingPreparedUpdate && firmwareUpdateInFlight);
  if (waitingForPreparedFlash) {
    publishFirmwareUpdatePanel({
      status: FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
      userMessage: PRODUCT_SELECT_RP2_GUIDANCE,
      canInstall: false,
    });
    shell.setStatus("");
  } else {
    // Legacy / debug bootloader path (hidden panel).
    shell.setStatus(PRODUCT_SELECT_RP2_GUIDANCE);
  }
  try {
    await dropPicoboot("Not connected");
    picobootSession = await requestAndClaimPicoboot();
    showPicobootInfo(picobootSession.info, "Connected (interface claimed, flash not written)");
    shell.setPicobootProtocol(emptyPicobootProtocolInfo());
    if (waitingForPreparedFlash) {
      // Keep WAITING_BOOTLOADER until flashPendingPreparedUpdate passes canStartFirmwareFlash.
      // Setting FLASHING here falsely trips the re-entry guard (Phase 5.6 de-dupe regression).
      publishFirmwareUpdatePanel({
        status: FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
        userMessage: PRODUCT_WRITING_PANEL_MESSAGE,
        canInstall: false,
      });
      shell.setStatus("");
    } else {
      shell.setStatus(PRODUCT_CONTINUE_GUIDANCE);
    }
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
      if (pendingPreparedUpdate) {
        publishFirmwareUpdatePanel({
          status: FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
          detail: null,
          userMessage: PRODUCT_USB_CANCELLED_GUIDANCE,
          canInstall: false,
        });
        shell.setStatus("");
      } else {
        shell.setStatus(PRODUCT_USB_CANCELLED_GUIDANCE);
      }
    } else {
      const message = error && error.message ? error.message : String(error);
      showIdleBootloader(`Failed: ${message}`, dump);
      if (pendingPreparedUpdate) {
        console.warn("[Firmware Update]", message);
        appendFlashLog(`Firmware Update error: ${message}`);
        publishFirmwareUpdatePanel({
          status: FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
          detail: null,
          userMessage: PRODUCT_CONTINUE_STATUS,
          canInstall: false,
        });
        shell.setStatus("");
      } else {
        shell.setStatus(message);
      }
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
    shell.setStatus("Select a known-good MP9 or MF5 UF2 first. Flash was not modified.");
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
    } else if (plan.ok && !isKnownProgrammableUf2Name(file.name)) {
      shell.setStatus(
        `Dry Run passed, but this PoC only programs known MP9/MF5 UF2 names. Flash was not modified.`
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
    appendFlashLog("PC_REBOOT issued after verify. Waiting for MIDI auto-reconnect / GET_INFO / GET_CONFIG.");
    shell.setStatus(
      "PC_REBOOT sent. Waiting for MIDI to return for GET_INFO and GET_CONFIG. Pre-update EEPROM probe is kept."
    );
    scheduleAutoConnect("flash-reboot");
  } catch (error) {
    const protocol = protocolInfoFromError(error);
    shell.setPicobootProtocol(protocol);
    appendFlashLog(`Reboot failed: ${protocol.protocolError} — staying in BOOTSEL.`);
    shell.setStatus(`${protocol.protocolError} Device stays in BOOTSEL.`);
  } finally {
    shell.setBusy(false);
  }
});

showDisconnectedEmpty();
shell.setDisconnected();
shell.setWebUsbAvailable(isWebUsbSupported());
showIdleBootloader(isWebUsbSupported() ? "Not connected" : "Failed: WebUSB is not available");
shell.setFlashPlan(emptyFlashPlanView());
shell.setFlashProgramLog("");
setFlashButtons({ write: false, reboot: false });
shell.setStatus("Connect a mini cube to get started.");

(async () => {
  const permission = await midiSysexPermissionState();
  if (permission === "granted") {
    shell.setStatus("Looking for your mini cube…");
    await tryAutoConnect({ reason: "load", quiet: true });
    return;
  }
  if (permission === "unknown") {
    // Some browsers omit Permissions API; try quietly and keep Connect as fallback.
    await tryAutoConnect({ reason: "load", quiet: true });
  }
})();
