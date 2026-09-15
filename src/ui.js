import { DRY_RUN_BANNER, emptyFlashPlanView } from "./flashPlan.js";
import {
  FW_UPDATE_UI_PHASE,
  MANUAL_BOOTLOADER_INSTRUCTIONS,
  firmwareUpdateInstallLabel,
  firmwareUpdatePrimaryMessage,
  formatFirmwareUpdatePhase,
  isFirmwareUpdateActivePhase,
  shouldShowFirmwareBootloaderConnect,
  shouldShowFirmwareCheckAgain,
} from "./firmwareUpdateUi.js";

function $(id) {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing #${id}`);
  }
  return el;
}

function emptyBootloaderInfo() {
  return {
    webusb: "—",
    result: "Not connected",
    chip: "—",
    vidPid: "—",
    product: "—",
    serial: "—",
    iface: "—",
    endpoints: "—",
    interfaceDump: "(not enumerated yet)",
  };
}

function emptyProtocolInfo() {
  return {
    commandName: "—",
    commandStatus: "—",
    response: "—",
    transferredBytes: "—",
    protocolError: "—",
  };
}

export function bindShell() {
  const connectBtn = $("connect-btn");
  const readBtn = $("read-btn");
  const saveBtn = $("save-btn");
  const restoreBtn = $("restore-btn");
  const firmwareUpdateBtn = $("firmware-update-btn");
  const checkFirmwareBtn = $("check-firmware-btn");
  const installFirmwareBtn = $("install-firmware-btn");
  const fwConnectBootloaderBtn = $("fw-connect-bootloader-btn");
  const fwUpdateMessageEl = $("fw-update-message");
  const fwUpdateVersionsEl = $("fw-update-versions");
  const fwUpdateCurrentEl = $("fw-update-current");
  const fwUpdateLatestEl = $("fw-update-latest");
  const fwUpdateErrorEl = $("fw-update-error");
  const fwUpdateErrorDetailEl = $("fw-update-error-detail");
  const fwUpdateManualBootselEl = $("fw-update-manual-bootsel");
  const connectBootloaderBtn = $("connect-bootloader-btn");
  const disconnectBootloaderBtn = $("disconnect-bootloader-btn");
  const testPicobootBtn = $("test-picoboot-btn");
  const uf2FileInput = $("uf2-file");
  const uf2DryRunBtn = $("uf2-dry-run-btn");
  const flashEraseBtn = $("flash-erase-btn");
  const flashWriteBtn = $("flash-write-btn");
  const flashRebootBtn = $("flash-reboot-btn");
  const flashPlanBannerEl = $("flash-plan-banner");
  const flashPlanSummaryEl = $("flash-plan-summary");
  const flashPlanEepromEl = $("flash-plan-eeprom");
  const flashProgramLogEl = $("flash-program-log");
  const statusEl = $("status");
  const deviceEl = $("device-name");
  const connectionEl = $("connection");
  const firmwareEl = $("firmware");
  const deviceRoot = $("device-root");
  const bootloaderWebusbEl = $("bootloader-webusb");
  const bootloaderResultEl = $("bootloader-result");
  const bootloaderChipEl = $("bootloader-chip");
  const bootloaderVidPidEl = $("bootloader-vidpid");
  const bootloaderProductEl = $("bootloader-product");
  const bootloaderSerialEl = $("bootloader-serial");
  const bootloaderInterfaceEl = $("bootloader-interface");
  const bootloaderEndpointsEl = $("bootloader-endpoints");
  const bootloaderInterfacesEl = $("bootloader-interfaces");
  const picobootCommandEl = $("picoboot-command");
  const picobootStatusEl = $("picoboot-status");
  const picobootResponseEl = $("picoboot-response");
  const picobootTransferredEl = $("picoboot-transferred");
  const picobootErrorEl = $("picoboot-error");

  let capabilities = {
    configReadWrite: false,
    save: false,
    restore: false,
    firmwareUpdate: false,
  };
  let view = null;
  let webUsbAvailable = false;
  let bootloaderConnected = false;
  let flashWriteEnabled = false;
  let flashRebootEnabled = false;
  let busy = false;
  let installFirmwareEnabled = false;
  let fwUpdatePhase = FW_UPDATE_UI_PHASE.IDLE;
  let fwCurrentVersion = "—";
  let fwLatestVersion = "—";
  let fwErrorDetail = "";
  let fwUserMessage = null;
  let fwManualBootloader = false;

  function isMidiConnected() {
    return connectionEl.textContent === "Connected";
  }

  function renderFirmwareUpdatePanel() {
    const midiConnected = isMidiConnected();
    const active = isFirmwareUpdateActivePhase(fwUpdatePhase);
    const showConnectPrompt =
      !midiConnected &&
      !active &&
      fwUpdatePhase !== FW_UPDATE_UI_PHASE.ERROR &&
      fwUpdatePhase !== FW_UPDATE_UI_PHASE.SUCCESS;
    const showManual =
      fwManualBootloader && fwUpdatePhase === FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER;
    const primary = firmwareUpdatePrimaryMessage(fwUpdatePhase, {
      connected: midiConnected,
      userMessage: showManual ? null : fwUserMessage,
    });
    fwUpdateMessageEl.textContent = showManual ? "" : primary;
    fwUpdateMessageEl.hidden = showManual || !primary;

    const showVersions =
      !showConnectPrompt &&
      (midiConnected || active || fwUpdatePhase === FW_UPDATE_UI_PHASE.SUCCESS) &&
      fwUpdatePhase !== FW_UPDATE_UI_PHASE.CHECKING;
    fwUpdateVersionsEl.hidden = !showVersions;
    fwUpdateCurrentEl.textContent = fwCurrentVersion || "—";
    fwUpdateLatestEl.textContent = fwLatestVersion || "—";

    const isError = fwUpdatePhase === FW_UPDATE_UI_PHASE.ERROR;
    fwUpdateErrorEl.hidden = !isError;
    fwUpdateErrorEl.textContent = isError ? "Update failed." : "";
    fwUpdateErrorDetailEl.hidden = !isError || !fwErrorDetail;
    fwUpdateErrorDetailEl.textContent = isError ? fwErrorDetail : "";

    fwUpdateManualBootselEl.hidden = !showManual;
    fwUpdateManualBootselEl.textContent = showManual ? MANUAL_BOOTLOADER_INSTRUCTIONS : "";

    const showCheckAgain = shouldShowFirmwareCheckAgain(fwUpdatePhase, {
      connected: midiConnected,
    });
    checkFirmwareBtn.hidden = !showCheckAgain;
    checkFirmwareBtn.textContent = "Check again";
    installFirmwareBtn.hidden = !installFirmwareEnabled;
    installFirmwareBtn.textContent = firmwareUpdateInstallLabel(fwLatestVersion);

    const showFwBootloader = shouldShowFirmwareBootloaderConnect(fwUpdatePhase);
    fwConnectBootloaderBtn.hidden = !showFwBootloader;
  }

  function applyActionState() {
    connectBtn.disabled = busy;
    const midiConnected = isMidiConnected();
    readBtn.disabled = busy || !midiConnected || !capabilities.configReadWrite;
    saveBtn.disabled = busy || !midiConnected || !capabilities.save;
    restoreBtn.disabled = busy || !midiConnected || !capabilities.restore;
    // ENTER_BOOTLOADER PoC control — kept wired, hidden from normal UI.
    firmwareUpdateBtn.hidden = true;
    firmwareUpdateBtn.disabled = busy || !midiConnected || !capabilities.firmwareUpdate;
    checkFirmwareBtn.disabled = busy || !midiConnected;
    installFirmwareBtn.disabled = busy || !installFirmwareEnabled;
    fwConnectBootloaderBtn.disabled = busy || !webUsbAvailable || bootloaderConnected;
    connectBootloaderBtn.disabled = busy || !webUsbAvailable || bootloaderConnected;
    disconnectBootloaderBtn.disabled = busy || !bootloaderConnected;
    testPicobootBtn.disabled = busy || !bootloaderConnected;
    uf2DryRunBtn.disabled = busy;
    flashEraseBtn.disabled = true;
    flashEraseBtn.title = "Standalone erase is not available. Write UF2 erases only the accepted Dry Run range.";
    flashWriteBtn.disabled = busy || !bootloaderConnected || !flashWriteEnabled;
    flashWriteBtn.title = flashWriteBtn.disabled
      ? "Write UF2 needs Connect to Bootloader, Dry Run ACCEPT, known MP9_V1.ino.uf2, and a kept EEPROM probe."
      : "Erase + write + verify the accepted Dry Run plan (no reboot yet)";
    flashRebootBtn.disabled = busy || !bootloaderConnected || !flashRebootEnabled;
    flashRebootBtn.title = flashRebootBtn.disabled
      ? "Reboot stays disabled until every page verifies."
      : "Verify passed. Reboot out of BOOTSEL.";
    if (view) {
      view.setEnabled(!busy && midiConnected && capabilities.configReadWrite);
    }
    renderFirmwareUpdatePanel();
  }

  applyActionState();

  return {
    deviceRoot,
    onConnect(handler) {
      connectBtn.addEventListener("click", handler);
    },
    onRead(handler) {
      readBtn.addEventListener("click", handler);
    },
    onSave(handler) {
      saveBtn.addEventListener("click", handler);
    },
    onRestore(handler) {
      restoreBtn.addEventListener("click", handler);
    },
    onFirmwareUpdate(handler) {
      firmwareUpdateBtn.addEventListener("click", handler);
    },
    onCheckFirmware(handler) {
      checkFirmwareBtn.addEventListener("click", handler);
    },
    onInstallFirmware(handler) {
      installFirmwareBtn.addEventListener("click", handler);
    },
    onConnectBootloader(handler) {
      connectBootloaderBtn.addEventListener("click", handler);
      fwConnectBootloaderBtn.addEventListener("click", handler);
    },
    onDisconnectBootloader(handler) {
      disconnectBootloaderBtn.addEventListener("click", handler);
    },
    onTestPicoboot(handler) {
      testPicobootBtn.addEventListener("click", handler);
    },
    onUf2FileChange(handler) {
      uf2FileInput.addEventListener("change", handler);
    },
    onUf2DryRun(handler) {
      uf2DryRunBtn.addEventListener("click", handler);
    },
    onFlashWrite(handler) {
      flashWriteBtn.addEventListener("click", handler);
    },
    onFlashReboot(handler) {
      flashRebootBtn.addEventListener("click", handler);
    },
    getUf2File() {
      return uf2FileInput.files && uf2FileInput.files[0] ? uf2FileInput.files[0] : null;
    },
    setFlashWriteEnabled(enabled) {
      flashWriteEnabled = Boolean(enabled);
      applyActionState();
    },
    setFlashRebootEnabled(enabled) {
      flashRebootEnabled = Boolean(enabled);
      applyActionState();
    },
    setInstallFirmwareEnabled(enabled) {
      installFirmwareEnabled = Boolean(enabled);
      applyActionState();
    },
    setFirmwareUpdatePanel({ status, current, latest, detail, userMessage, manualBootloader } = {}) {
      if (status != null) {
        fwUpdatePhase = formatFirmwareUpdatePhase(status);
      }
      if (current !== undefined) {
        fwCurrentVersion = current == null || current === "" ? "—" : String(current);
      }
      if (latest !== undefined) {
        fwLatestVersion = latest == null || latest === "" ? "—" : String(latest);
      }
      if (userMessage !== undefined) {
        fwUserMessage = userMessage;
      } else if (status != null) {
        fwUserMessage = null;
      }
      if (manualBootloader !== undefined) {
        fwManualBootloader = Boolean(manualBootloader);
      } else if (status != null && status !== FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER) {
        fwManualBootloader = false;
      }
      if (fwUpdatePhase === FW_UPDATE_UI_PHASE.ERROR) {
        fwErrorDetail = detail == null ? "" : String(detail);
      } else if (status != null || detail === null) {
        fwErrorDetail = "";
      }
      applyActionState();
    },
    setStatus(text) {
      statusEl.textContent = text;
    },
    setBusy(nextBusy) {
      busy = Boolean(nextBusy);
      applyActionState();
    },
    setDeviceView(nextView, nextCapabilities) {
      view = nextView;
      capabilities = {
        configReadWrite: Boolean(nextCapabilities?.configReadWrite),
        save: Boolean(nextCapabilities?.save),
        restore: Boolean(nextCapabilities?.restore),
        firmwareUpdate: Boolean(nextCapabilities?.firmwareUpdate),
      };
      applyActionState();
    },
    clearDeviceView() {
      deviceRoot.replaceChildren();
      view = null;
      capabilities = {
        configReadWrite: false,
        save: false,
        restore: false,
        firmwareUpdate: false,
      };
    },
    setDisconnected(statusText) {
      deviceEl.textContent = "—";
      connectionEl.textContent = "Disconnected";
      firmwareEl.textContent = "—";
      if (statusText) {
        statusEl.textContent = statusText;
      }
      applyActionState();
    },
    setConnected(info) {
      deviceEl.textContent = info.model;
      connectionEl.textContent = "Connected";
      firmwareEl.textContent = info.firmware;
      applyActionState();
    },
    setWebUsbAvailable(available) {
      webUsbAvailable = Boolean(available);
      bootloaderWebusbEl.textContent = webUsbAvailable ? "Available" : "Not available";
      applyActionState();
    },
    setBootloaderConnected(connected) {
      bootloaderConnected = Boolean(connected);
      applyActionState();
    },
    setBootloaderInfo(info) {
      const next = { ...emptyBootloaderInfo(), ...info };
      bootloaderWebusbEl.textContent = next.webusb;
      bootloaderResultEl.textContent = next.result;
      bootloaderChipEl.textContent = next.chip;
      bootloaderVidPidEl.textContent = next.vidPid;
      bootloaderProductEl.textContent = next.product;
      bootloaderSerialEl.textContent = next.serial;
      bootloaderInterfaceEl.textContent = next.iface;
      bootloaderEndpointsEl.textContent = next.endpoints;
      bootloaderInterfacesEl.textContent = next.interfaceDump || "(not enumerated yet)";
    },
    setPicobootProtocol(info) {
      const next = { ...emptyProtocolInfo(), ...info };
      picobootCommandEl.textContent = next.commandName;
      picobootStatusEl.textContent = next.commandStatus;
      picobootResponseEl.textContent = next.response;
      picobootTransferredEl.textContent = next.transferredBytes;
      picobootErrorEl.textContent = next.protocolError;
    },
    setFlashPlan({ banner, summary, eeprom } = {}) {
      const idle = emptyFlashPlanView();
      flashPlanBannerEl.textContent = banner || DRY_RUN_BANNER;
      flashPlanSummaryEl.textContent = summary || idle.summary;
      flashPlanEepromEl.textContent = eeprom || idle.eeprom;
    },
    setFlashProgramLog(text) {
      flashProgramLogEl.textContent = text || "Write UF2 is idle. Dry Run ACCEPT is required first.";
    },
    setConfig(config) {
      if (view) {
        view.setConfig(config);
      }
    },
    getConfig() {
      if (!view) {
        throw new Error("No device UI is mounted.");
      }
      return view.getConfig();
    },
  };
}
