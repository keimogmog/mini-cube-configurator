import assert from "node:assert/strict";
import {
  DEFAULT_FIRMWARE_MANIFEST_URL,
  FW_UPDATE_UI_PHASE,
  MANUAL_BOOTLOADER_INSTRUCTIONS,
  canStartFirmwareFlash,
  canStartFirmwareInstall,
  evaluateUpdateCheck,
  firmwareUpdateInstallLabel,
  firmwareUpdatePrimaryMessage,
  formatFirmwareUpdatePhase,
  isFirmwareUpdateActivePhase,
  requiresManualBootloaderEntry,
  resolveFirmwareBootloaderEntry,
  shouldShowFirmwareBootloaderConnect,
  shouldShowFirmwareCheckAgain,
} from "../src/firmwareUpdateUi.js";
import { FIRMWARE_VERSION_RELATION } from "../src/versionCompare.js";

assert.equal(DEFAULT_FIRMWARE_MANIFEST_URL, "./firmware/latest/manifest.json");

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
  true
);
assert.equal(
  canStartFirmwareFlash({
    hasPrepared: true,
    hasPicobootSession: true,
    productId: 0x0003,
    phase: FW_UPDATE_UI_PHASE.FLASHING,
  }),
  false,
  "blocks re-entrant flash"
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
  "Connect your device to check for updates."
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.CHECKING, { connected: true }),
  "Checking for updates..."
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
  "Downloading update..."
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER, { connected: false }),
  "Device is ready for firmware update. Connect to Bootloader to continue."
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.FLASHING, { connected: false }),
  "Installing firmware..."
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.FLASHING, {
    connected: false,
    userMessage: "Restarting device...",
  }),
  "Restarting device..."
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.SUCCESS, { connected: false }),
  "Firmware update complete."
);
assert.equal(
  firmwareUpdatePrimaryMessage(FW_UPDATE_UI_PHASE.ERROR, { connected: true }),
  ""
);

assert.equal(firmwareUpdateInstallLabel("0.3.0"), "Update to 0.3.0");
assert.equal(firmwareUpdateInstallLabel(null), "Update");
assert.equal(shouldShowFirmwareBootloaderConnect(FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER), true);
assert.equal(shouldShowFirmwareBootloaderConnect(FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE), false);
assert.equal(isFirmwareUpdateActivePhase(FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER), true);
assert.equal(isFirmwareUpdateActivePhase(FW_UPDATE_UI_PHASE.IDLE), false);

assert.equal(
  shouldShowFirmwareCheckAgain(FW_UPDATE_UI_PHASE.UP_TO_DATE, { connected: true }),
  false,
  "auto-check success hides Check again"
);
assert.equal(
  shouldShowFirmwareCheckAgain(FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE, { connected: true }),
  false
);
assert.equal(
  shouldShowFirmwareCheckAgain(FW_UPDATE_UI_PHASE.ERROR, { connected: true }),
  true,
  "error offers Check again"
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
  assert.equal(newer.manual, false);
}

{
  const bad = requiresManualBootloaderEntry("v1", "0.3.0");
  assert.equal(bad.ok, false);
  assert.equal(bad.manual, false);
  assert.match(bad.error, /malformed/i);
}

assert.match(MANUAL_BOOTLOADER_INSTRUCTIONS, /manual bootloader mode/i);
assert.match(MANUAL_BOOTLOADER_INSTRUCTIONS, /Hold the BOOTSEL button/);

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

console.log("firmware-update-ui tests passed");
