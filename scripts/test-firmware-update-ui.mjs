import assert from "node:assert/strict";
import {
  DEFAULT_FIRMWARE_MANIFEST_URL,
  FIRMWARE_UPDATE_CONTINUE_LABEL,
  FIRMWARE_UPDATE_TRY_AGAIN_LABEL,
  FW_UPDATE_UI_PHASE,
  MANUAL_BOOTLOADER_INSTRUCTIONS,
  MF5_FIRMWARE_MANIFEST_URL,
  PRODUCT_CONTINUE_GUIDANCE,
  PRODUCT_DOWNLOAD_FAILED_GUIDANCE,
  PRODUCT_ENTERING_UPDATE_MODE_GUIDANCE,
  PRODUCT_ENTER_UPDATE_MODE_FAILED_GUIDANCE,
  PRODUCT_KEEP_USB_CONNECTED,
  PRODUCT_PREPARING_GUIDANCE,
  PRODUCT_RECONNECTING_GUIDANCE,
  PRODUCT_RESTARTING_GUIDANCE,
  PRODUCT_SELECT_RP2_GUIDANCE,
  PRODUCT_USB_CANCELLED_GUIDANCE,
  PRODUCT_VERIFYING_GUIDANCE,
  PRODUCT_WRITING_GUIDANCE,
  PRODUCT_WRITING_PANEL_MESSAGE,
  canStartFirmwareFlash,
  canStartFirmwareInstall,
  connectedStatusMessage,
  evaluateUpdateCheck,
  firmwareManifestUrlForProfile,
  firmwareUpdateFlashProgressMessage,
  firmwareUpdateInstallLabel,
  firmwareUpdatePrimaryMessage,
  firmwareUpdateSuccessMessage,
  firmwareUpdateUserFacingDetail,
  formatFirmwareUpdatePhase,
  isFirmwareUpdateActivePhase,
  requiresManualBootloaderEntry,
  resolveFirmwareBootloaderEntry,
  shouldShowFirmwareBootloaderConnect,
  shouldShowFirmwareCheckAgain,
  shouldSuppressGlobalStatusForFirmwareUpdate,
} from "../src/firmwareUpdateUi.js";
import { FIRMWARE_VERSION_RELATION } from "../src/versionCompare.js";

assert.equal(DEFAULT_FIRMWARE_MANIFEST_URL, "./firmware/latest/manifest.json");
assert.equal(MF5_FIRMWARE_MANIFEST_URL, "./firmware/mf5/latest/manifest.json");
assert.equal(
  firmwareManifestUrlForProfile({ id: "mp9", firmwareManifestUrl: "./firmware/latest/manifest.json" }),
  "./firmware/latest/manifest.json"
);
assert.equal(
  firmwareManifestUrlForProfile({ id: "mf5", displayName: "MF5" }),
  "./firmware/mf5/latest/manifest.json"
);

{
  const available = evaluateUpdateCheck("0.3.0", "0.3.1");
  assert.equal(available.phase, FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE);
  assert.equal(available.relation, FIRMWARE_VERSION_RELATION.OLDER);
  assert.equal(available.canInstall, true);
}

{
  const equal = evaluateUpdateCheck("0.3.1", "0.3.1");
  assert.equal(equal.phase, FW_UPDATE_UI_PHASE.UP_TO_DATE);
  assert.equal(equal.canInstall, false);
}

{
  const newer = evaluateUpdateCheck("0.4.0", "0.3.1");
  assert.equal(newer.phase, FW_UPDATE_UI_PHASE.UP_TO_DATE);
  assert.equal(newer.relation, FIRMWARE_VERSION_RELATION.NEWER);
  assert.equal(newer.canInstall, false);
}

{
  const bad = evaluateUpdateCheck("v1", "0.3.1");
  assert.equal(bad.phase, FW_UPDATE_UI_PHASE.ERROR);
  assert.equal(bad.canInstall, false);
  assert.match(bad.detail, /Couldn't read the firmware version/i);
}

assert.equal(
  canStartFirmwareInstall({
    phase: FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE,
    inFlight: false,
    hasMidiSession: true,
  }),
  true
);
assert.equal(
  canStartFirmwareInstall({
    phase: FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE,
    inFlight: false,
    hasPicobootSession: true,
  }),
  true
);
assert.equal(
  canStartFirmwareInstall({
    phase: FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE,
    inFlight: true,
    hasMidiSession: true,
  }),
  false,
  "in-flight blocks double install"
);
assert.equal(
  canStartFirmwareInstall({
    phase: FW_UPDATE_UI_PHASE.UP_TO_DATE,
    inFlight: false,
    hasMidiSession: true,
  }),
  false,
  "no flash when up to date"
);
assert.equal(
  canStartFirmwareInstall({
    phase: FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE,
    inFlight: false,
    hasMidiSession: false,
    hasPicobootSession: false,
  }),
  false,
  "fail closed without session"
);

assert.equal(
  canStartFirmwareFlash({
    hasPrepared: true,
    hasPicobootSession: true,
    productId: 0x0003,
    phase: FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
  }),
  true,
  "WAITING + prepared + RP2040 session may start flash (Continue→claim path)"
);
assert.equal(
  canStartFirmwareFlash({
    hasPrepared: true,
    hasPicobootSession: true,
    productId: 0x0003,
    phase: FW_UPDATE_UI_PHASE.FLASHING,
  }),
  false,
  "FLASHING + prepared + RP2040 session blocks re-entrant flash"
);
// Phase 5.6 de-dupe regression: post-claim Writing copy must not flip phase to FLASHING
// before canStartFirmwareFlash runs (same inputs as Continue→claim→flash entry).
assert.equal(
  canStartFirmwareFlash({
    hasPrepared: true,
    hasPicobootSession: true,
    productId: 0x0003,
    phase: FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
  }),
  true,
  "post-claim Writing UI must keep WAITING so flash gate still opens"
);
assert.equal(
  canStartFirmwareFlash({
    hasPrepared: true,
    hasPicobootSession: true,
    productId: 0x000f,
  }),
  false
);
assert.equal(
  canStartFirmwareFlash({
    hasPrepared: false,
    hasPicobootSession: true,
    productId: 0x0003,
  }),
  false
);
assert.equal(
  canStartFirmwareFlash({
    hasPrepared: true,
    hasPicobootSession: false,
    productId: 0x0003,
  }),
  false
);

assert.equal(formatFirmwareUpdatePhase(FW_UPDATE_UI_PHASE.CHECKING), "checking");
assert.equal(formatFirmwareUpdatePhase("nope"), FW_UPDATE_UI_PHASE.IDLE);

assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.IDLE, { connected: false }),
  "Connect your mini cube to check for updates."
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.CHECKING, { connected: true }),
  "Checking for updates…"
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.UP_TO_DATE, { connected: true }),
  "Firmware is up to date."
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE, { connected: true }),
  ""
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.DOWNLOADING, { connected: true }),
  PRODUCT_PREPARING_GUIDANCE
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER, { connected: false }),
  PRODUCT_CONTINUE_GUIDANCE
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.FLASHING, { connected: false }),
  PRODUCT_WRITING_PANEL_MESSAGE
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.FLASHING, {
    connected: false,
    userMessage: PRODUCT_RESTARTING_GUIDANCE,
  }),
  PRODUCT_RESTARTING_GUIDANCE
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.FLASHING, {
    connected: false,
    userMessage: PRODUCT_RECONNECTING_GUIDANCE,
  }),
  PRODUCT_RECONNECTING_GUIDANCE
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.SUCCESS, { connected: false }),
  "Firmware updated."
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.SUCCESS, {
    connected: true,
    userMessage: firmwareUpdateSuccessMessage("0.2.1"),
  }),
  "Firmware updated to 0.2.1"
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.ERROR, { connected: true }),
  ""
);

assert.equal(firmwareUpdateInstallLabel("0.3.0"), "Update to 0.3.0");
assert.equal(firmwareUpdateInstallLabel(null), "Update");
assert.equal(FIRMWARE_UPDATE_CONTINUE_LABEL, "Continue");
assert.equal(FIRMWARE_UPDATE_TRY_AGAIN_LABEL, "Try again");
assert.equal(PRODUCT_CONTINUE_GUIDANCE, "Click Continue, then select RP2 Boot.");
assert.equal(PRODUCT_SELECT_RP2_GUIDANCE, "Select RP2 Boot in the browser window.");
assert.equal(PRODUCT_WRITING_GUIDANCE, "Writing firmware…");
assert.equal(PRODUCT_KEEP_USB_CONNECTED, "Keep the USB cable connected.");
assert.equal(
  PRODUCT_WRITING_PANEL_MESSAGE,
  "Writing firmware…\nKeep the USB cable connected."
);
assert.equal(PRODUCT_VERIFYING_GUIDANCE, "Verifying…");
assert.equal(PRODUCT_RESTARTING_GUIDANCE, "Restarting…");
assert.equal(PRODUCT_RECONNECTING_GUIDANCE, "Reconnecting automatically…");
assert.equal(PRODUCT_PREPARING_GUIDANCE, "Preparing…");
assert.equal(PRODUCT_ENTERING_UPDATE_MODE_GUIDANCE, "Entering update mode…");
assert.equal(
  PRODUCT_USB_CANCELLED_GUIDANCE,
  "USB access was cancelled. Click Continue and select RP2 Boot."
);
assert.equal(connectedStatusMessage({ displayName: "MF5" }), "MF5 connected");
assert.equal(connectedStatusMessage({ displayName: "MP9" }), "MP9 connected");
assert.equal(connectedStatusMessage(null), "");
assert.equal(
  PRODUCT_ENTER_UPDATE_MODE_FAILED_GUIDANCE,
  "Couldn't enter update mode. Keep the USB cable connected and try again."
);
assert.equal(
  PRODUCT_DOWNLOAD_FAILED_GUIDANCE,
  "Couldn't download the update. Check your internet connection and try again."
);
assert.equal(firmwareUpdateSuccessMessage("0.2.1"), "Firmware updated to 0.2.1");
assert.equal(firmwareUpdateSuccessMessage(""), "Firmware updated.");
assert.equal(firmwareUpdateFlashProgressMessage("erase"), PRODUCT_WRITING_PANEL_MESSAGE);
assert.equal(firmwareUpdateFlashProgressMessage("write"), PRODUCT_WRITING_PANEL_MESSAGE);
assert.equal(firmwareUpdateFlashProgressMessage("verify"), PRODUCT_VERIFYING_GUIDANCE);
assert.equal(firmwareUpdateFlashProgressMessage("eeprom-check"), PRODUCT_VERIFYING_GUIDANCE);
assert.equal(
  firmwareUpdateUserFacingDetail("UF2 SHA-256 does not match manifest.sha256"),
  "The update file could not be verified."
);
assert.equal(
  firmwareUpdateUserFacingDetail("flash plan rejected (Dry Run REJECT)"),
  "This update is not compatible."
);
assert.equal(
  firmwareUpdateUserFacingDetail("eepromBytes is required before flash"),
  "Update could not be verified. Try again."
);
assert.equal(
  firmwareUpdateUserFacingDetail("User cancelled the requestDevice() chooser."),
  PRODUCT_USB_CANCELLED_GUIDANCE
);
assert.equal(
  firmwareUpdateUserFacingDetail("Timed out waiting for the device. Is configurator firmware loaded?"),
  PRODUCT_ENTER_UPDATE_MODE_FAILED_GUIDANCE
);
assert.equal(
  firmwareUpdateUserFacingDetail("Device rejected command 0x6 (unknown command)."),
  PRODUCT_ENTER_UPDATE_MODE_FAILED_GUIDANCE
);
assert.equal(
  firmwareUpdateUserFacingDetail("ENTER_BOOTLOADER failed"),
  PRODUCT_ENTER_UPDATE_MODE_FAILED_GUIDANCE
);
assert.equal(
  firmwareUpdateUserFacingDetail("UF2 fetch failed: Failed to fetch"),
  PRODUCT_DOWNLOAD_FAILED_GUIDANCE
);
assert.equal(
  firmwareUpdateUserFacingDetail("manifest fetch HTTP 404"),
  PRODUCT_DOWNLOAD_FAILED_GUIDANCE
);
assert.equal(
  firmwareUpdateUserFacingDetail("NetworkError when attempting to fetch resource."),
  PRODUCT_DOWNLOAD_FAILED_GUIDANCE
);
assert.match(firmwareUpdateUserFacingDetail("mystery stack"), /Something went wrong/i);
for (const banned of ["PICOBOOT", "SysEx", "0x06", "SHA-256", "Dry Run", "GET_INFO"]) {
  const samples = [
    PRODUCT_ENTER_UPDATE_MODE_FAILED_GUIDANCE,
    PRODUCT_DOWNLOAD_FAILED_GUIDANCE,
    PRODUCT_USB_CANCELLED_GUIDANCE,
    PRODUCT_CONTINUE_GUIDANCE,
    PRODUCT_WRITING_PANEL_MESSAGE,
    firmwareUpdateSuccessMessage("0.2.1"),
    firmwareUpdateUserFacingDetail("Device rejected command 0x6 (unknown command)."),
    firmwareUpdateUserFacingDetail("UF2 SHA-256 does not match"),
    firmwareUpdateUserFacingDetail("flash plan rejected (Dry Run REJECT)"),
  ];
  for (const text of samples) {
    assert.equal(text.includes(banned), false, `user-facing text must not contain ${banned}`);
  }
}
assert.equal(shouldShowFirmwareBootloaderConnect(FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER), true);
assert.equal(shouldShowFirmwareBootloaderConnect(FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE), false);
assert.equal(isFirmwareUpdateActivePhase(FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER), true);
assert.equal(isFirmwareUpdateActivePhase(FW_UPDATE_UI_PHASE.IDLE), false);
assert.equal(
  shouldSuppressGlobalStatusForFirmwareUpdate(FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER),
  true
);
assert.equal(
  shouldSuppressGlobalStatusForFirmwareUpdate(FW_UPDATE_UI_PHASE.FLASHING),
  true
);
assert.equal(
  shouldSuppressGlobalStatusForFirmwareUpdate(FW_UPDATE_UI_PHASE.DOWNLOADING),
  true
);
assert.equal(
  shouldSuppressGlobalStatusForFirmwareUpdate(FW_UPDATE_UI_PHASE.CHECKING),
  false,
  "quiet version check must not hide normal connected Status"
);
assert.equal(
  shouldSuppressGlobalStatusForFirmwareUpdate(FW_UPDATE_UI_PHASE.ERROR),
  true
);
assert.equal(
  shouldSuppressGlobalStatusForFirmwareUpdate(FW_UPDATE_UI_PHASE.SUCCESS),
  false,
  "success leaves global Status for normal connected copy"
);
assert.equal(
  shouldSuppressGlobalStatusForFirmwareUpdate(FW_UPDATE_UI_PHASE.UP_TO_DATE),
  false
);
assert.equal(
  shouldSuppressGlobalStatusForFirmwareUpdate(FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE),
  false
);

assert.equal(
  shouldShowFirmwareCheckAgain(FW_UPDATE_UI_PHASE.UP_TO_DATE, { connected: true }),
  false,
  "auto-check success hides Try again"
);
assert.equal(
  shouldShowFirmwareCheckAgain(FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE, { connected: true }),
  false
);
assert.equal(
  shouldShowFirmwareCheckAgain(FW_UPDATE_UI_PHASE.ERROR, { connected: true }),
  true,
  "error offers Try again"
);
assert.equal(
  shouldShowFirmwareCheckAgain(FW_UPDATE_UI_PHASE.ERROR, { connected: false }),
  false
);

{
  const legacy = requiresManualBootloaderEntry("0.2.0", "0.3.0");
  assert.equal(legacy.ok, true);
  assert.equal(legacy.manual, true, "0.2.0 < 0.3.0 uses manual BOOTSEL");
}

{
  const current = requiresManualBootloaderEntry("0.3.0", "0.3.0");
  assert.equal(current.ok, true);
  assert.equal(current.manual, false, "at minimum uses ENTER_BOOTLOADER");
}

{
  const newer = requiresManualBootloaderEntry("0.3.1", "0.3.0");
  assert.equal(newer.ok, true);
  assert.equal(newer.manual, false, "0.3.1 uses automatic ENTER_BOOTLOADER");
}

{
  const shipping = requiresManualBootloaderEntry("0.3.2", "0.3.0");
  assert.equal(shipping.ok, true);
  assert.equal(shipping.manual, false, "0.3.2 shipping baseline stays automatic");
}

{
  const bad = requiresManualBootloaderEntry("v1", "0.3.0");
  assert.equal(bad.ok, false);
  assert.equal(bad.manual, false);
  assert.match(bad.error, /Couldn't read the firmware version/i);
}

assert.match(
  MANUAL_BOOTLOADER_INSTRUCTIONS,
  /older firmware that cannot enter update mode automatically/i,
  "manual path must identify older-firmware exception"
);
assert.match(
  MANUAL_BOOTLOADER_INSTRUCTIONS,
  /Manual BOOTSEL is required only for this older firmware/i,
  "manual path must not look like the normal shipping procedure"
);
assert.match(MANUAL_BOOTLOADER_INSTRUCTIONS, /Hold the BOOTSEL button/);
assert.match(MANUAL_BOOTLOADER_INSTRUCTIONS, /Disconnect the USB cable/);
assert.match(MANUAL_BOOTLOADER_INSTRUCTIONS, /select RP2 Boot/i);
assert.doesNotMatch(
  MANUAL_BOOTLOADER_INSTRUCTIONS,
  /in the browser window/,
  "manual BOOTSEL continue line stays short like product Continue guidance"
);

assert.equal(
  resolveFirmwareBootloaderEntry({
    currentFirmware: "0.2.0",
    minEnterBootloader: "0.3.0",
    hasPicobootRp2040: false,
  }).action,
  "manual-bootsel",
  "legacy current must not take enter-bootloader action"
);
assert.equal(
  resolveFirmwareBootloaderEntry({
    currentFirmware: "0.3.0",
    minEnterBootloader: "0.3.0",
    hasPicobootRp2040: false,
  }).action,
  "enter-bootloader",
  "current at minimum keeps automatic ENTER_BOOTLOADER"
);
assert.equal(
  resolveFirmwareBootloaderEntry({
    currentFirmware: "0.3.1",
    minEnterBootloader: "0.3.0",
    hasPicobootRp2040: false,
  }).action,
  "enter-bootloader",
  "0.3.1 keeps automatic ENTER_BOOTLOADER"
);
assert.equal(
  resolveFirmwareBootloaderEntry({
    currentFirmware: "0.3.2",
    minEnterBootloader: "0.3.0",
    hasPicobootRp2040: false,
  }).action,
  "enter-bootloader",
  "0.3.2 keeps automatic ENTER_BOOTLOADER"
);
assert.equal(
  resolveFirmwareBootloaderEntry({
    currentFirmware: "0.2.0",
    minEnterBootloader: "0.3.0",
    hasPicobootRp2040: true,
  }).action,
  "flash-now",
  "manual path still continues through existing flash when PICOBOOT is already claimed"
);
assert.equal(
  resolveFirmwareBootloaderEntry({
    currentFirmware: "bad",
    minEnterBootloader: "0.3.0",
    hasPicobootRp2040: false,
  }).action,
  "error"
);

// Automatic / shipping guidance must never present the legacy physical BOOTSEL recipe.
{
  const automaticGuidance = [
    PRODUCT_PREPARING_GUIDANCE,
    PRODUCT_ENTERING_UPDATE_MODE_GUIDANCE,
    PRODUCT_CONTINUE_GUIDANCE,
    PRODUCT_SELECT_RP2_GUIDANCE,
    PRODUCT_WRITING_GUIDANCE,
    PRODUCT_KEEP_USB_CONNECTED,
    PRODUCT_WRITING_PANEL_MESSAGE,
    PRODUCT_VERIFYING_GUIDANCE,
    PRODUCT_RESTARTING_GUIDANCE,
    PRODUCT_RECONNECTING_GUIDANCE,
    PRODUCT_USB_CANCELLED_GUIDANCE,
    PRODUCT_ENTER_UPDATE_MODE_FAILED_GUIDANCE,
    PRODUCT_DOWNLOAD_FAILED_GUIDANCE,
    firmwareUpdateSuccessMessage("0.3.2"),
    firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER, {
      connected: false,
      userMessage: PRODUCT_CONTINUE_GUIDANCE,
    }),
    firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER, {
      connected: false,
      userMessage: PRODUCT_SELECT_RP2_GUIDANCE,
    }),
  ];
  for (const text of automaticGuidance) {
    assert.equal(
      text.includes("Disconnect the USB cable"),
      false,
      "automatic path must not show Disconnect the USB cable"
    );
    assert.equal(
      text.includes("Hold the BOOTSEL button"),
      false,
      "automatic path must not show Hold the BOOTSEL button"
    );
    assert.equal(
      /older firmware/i.test(text),
      false,
      "automatic path must not mention older-firmware manual recovery"
    );
  }
}

console.log("firmware-update-ui tests passed");
