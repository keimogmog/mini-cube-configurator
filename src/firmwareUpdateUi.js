/**
 * Firmware update GUI wiring helpers (UI-agnostic).
 *
 * Does not fetch, flash, or parse manifests. Callers use firmwareDist /
 * firmwareUpdate / versionCompare and feed results here.
 */

import {
  FIRMWARE_VERSION_RELATION,
  compareFirmwareVersions,
} from "./versionCompare.js";

/** Same-origin Pages path from the design doc. */
export const DEFAULT_FIRMWARE_MANIFEST_URL = "./firmware/latest/manifest.json";

export const FW_UPDATE_UI_PHASE = Object.freeze({
  IDLE: "idle",
  CHECKING: "checking",
  UP_TO_DATE: "up to date",
  UPDATE_AVAILABLE: "update available",
  DOWNLOADING: "downloading / verifying",
  WAITING_BOOTLOADER: "waiting for bootloader",
  FLASHING: "flashing",
  SUCCESS: "success",
  ERROR: "error",
});

/**
 * Map device firmware + published latest into an update-check outcome.
 *
 * @param {unknown} currentFirmware  GET_INFO style "x.y.z"
 * @param {unknown} latestVersion    manifest.version
 * @returns {{
 *   phase: string,
 *   relation: string,
 *   canInstall: boolean,
 *   detail: string,
 * }}
 */
export function evaluateUpdateCheck(currentFirmware, latestVersion) {
  const relation = compareFirmwareVersions(currentFirmware, latestVersion);

  if (relation === FIRMWARE_VERSION_RELATION.MALFORMED) {
    return {
      phase: FW_UPDATE_UI_PHASE.ERROR,
      relation,
      canInstall: false,
      detail: "Firmware version compare failed (malformed current or latest).",
    };
  }

  if (relation === FIRMWARE_VERSION_RELATION.OLDER) {
    return {
      phase: FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE,
      relation,
      canInstall: true,
      detail: `Update available: ${String(currentFirmware)} → ${String(latestVersion)}`,
    };
  }

  if (relation === FIRMWARE_VERSION_RELATION.NEWER) {
    return {
      phase: FW_UPDATE_UI_PHASE.UP_TO_DATE,
      relation,
      canInstall: false,
      detail: `Device firmware ${String(currentFirmware)} is newer than published ${String(latestVersion)}. Downgrade is not offered.`,
    };
  }

  return {
    phase: FW_UPDATE_UI_PHASE.UP_TO_DATE,
    relation,
    canInstall: false,
    detail: `Up to date (${String(currentFirmware)}).`,
  };
}

/**
 * Whether Install may begin (download / enter bootloader). Not the write itself.
 *
 * @param {{
 *   phase?: string,
 *   inFlight?: boolean,
 *   hasMidiSession?: boolean,
 *   hasPicobootSession?: boolean,
 * }} state
 * @returns {boolean}
 */
export function canStartFirmwareInstall(state = {}) {
  if (state.inFlight) {
    return false;
  }
  if (state.phase !== FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE) {
    return false;
  }
  return Boolean(state.hasMidiSession || state.hasPicobootSession);
}

/**
 * Whether the prepared update may be programmed (fail closed without RP2040 session).
 *
 * @param {{
 *   inFlight?: boolean,
 *   hasPrepared?: boolean,
 *   hasPicobootSession?: boolean,
 *   productId?: number | null,
 *   phase?: string,
 * }} state
 * @returns {boolean}
 */
export function canStartFirmwareFlash(state = {}) {
  if (!state.hasPrepared) {
    return false;
  }
  if (!state.hasPicobootSession || state.productId !== 0x0003) {
    return false;
  }
  if (state.phase === FW_UPDATE_UI_PHASE.FLASHING) {
    return false;
  }
  return true;
}

/**
 * @param {string} phase
 * @returns {string}
 */
export function formatFirmwareUpdatePhase(phase) {
  const value = String(phase || "");
  const known = Object.values(FW_UPDATE_UI_PHASE);
  return known.includes(value) ? value : FW_UPDATE_UI_PHASE.IDLE;
}

const ACTIVE_WITHOUT_MIDI = new Set([
  FW_UPDATE_UI_PHASE.CHECKING,
  FW_UPDATE_UI_PHASE.DOWNLOADING,
  FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER,
  FW_UPDATE_UI_PHASE.FLASHING,
]);

/**
 * Whether the panel should keep mid-update chrome without a MIDI session.
 * Presentation only — does not change phase meanings.
 *
 * @param {string} phase
 * @returns {boolean}
 */
export function isFirmwareUpdateActivePhase(phase) {
  return ACTIVE_WITHOUT_MIDI.has(formatFirmwareUpdatePhase(phase));
}

/**
 * Primary user-facing copy for the firmware update panel.
 * Presentation only — does not decide update availability.
 *
 * @param {string} phase
 * @param {{ connected?: boolean, userMessage?: string | null }} [options]
 * @returns {string}
 */
export function firmwareUpdatePrimaryMessage(phase, options = {}) {
  if (options.userMessage) {
    return String(options.userMessage);
  }

  const value = formatFirmwareUpdatePhase(phase);
  const connected = Boolean(options.connected);

  if (!connected && !isFirmwareUpdateActivePhase(value)) {
    if (
      value === FW_UPDATE_UI_PHASE.IDLE ||
      value === FW_UPDATE_UI_PHASE.UP_TO_DATE ||
      value === FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE
    ) {
      return "Connect your device to check for updates.";
    }
  }

  switch (value) {
    case FW_UPDATE_UI_PHASE.CHECKING:
      return "Checking for updates...";
    case FW_UPDATE_UI_PHASE.UP_TO_DATE:
      return "Firmware is up to date.";
    case FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE:
      return "";
    case FW_UPDATE_UI_PHASE.DOWNLOADING:
      return "Downloading update...";
    case FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER:
      return "Device is ready for firmware update. Connect to Bootloader to continue.";
    case FW_UPDATE_UI_PHASE.FLASHING:
      return "Installing firmware...";
    case FW_UPDATE_UI_PHASE.SUCCESS:
      return "Firmware update complete.";
    case FW_UPDATE_UI_PHASE.ERROR:
      return "";
    case FW_UPDATE_UI_PHASE.IDLE:
    default:
      return connected ? "" : "Connect your device to check for updates.";
  }
}

/**
 * Install button label. Presentation only.
 *
 * @param {unknown} latestVersion
 * @returns {string}
 */
export function firmwareUpdateInstallLabel(latestVersion) {
  const version = latestVersion == null ? "" : String(latestVersion).trim();
  if (version && version !== "—") {
    return `Update to ${version}`;
  }
  return "Update";
}

/**
 * @param {string} phase
 * @returns {boolean}
 */
export function shouldShowFirmwareBootloaderConnect(phase) {
  return formatFirmwareUpdatePhase(phase) === FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER;
}

/**
 * Manual re-check is only offered after an error (auto-check covers the normal path).
 * Presentation only.
 *
 * @param {string} phase
 * @param {{ connected?: boolean }} [options]
 * @returns {boolean}
 */
export function shouldShowFirmwareCheckAgain(phase, options = {}) {
  if (!options.connected) {
    return false;
  }
  return formatFirmwareUpdatePhase(phase) === FW_UPDATE_UI_PHASE.ERROR;
}

/**
 * Whether the device must use physical BOOTSEL instead of ENTER_BOOTLOADER.
 * Uses manifest minDeviceFirmwareForEnterBootloader — no version hardcoding.
 *
 * @param {unknown} currentFirmware
 * @param {unknown} minEnterBootloader
 * @returns {{
 *   ok: true,
 *   manual: boolean,
 * } | {
 *   ok: false,
 *   manual: false,
 *   error: string,
 * }}
 */
export function requiresManualBootloaderEntry(currentFirmware, minEnterBootloader) {
  const relation = compareFirmwareVersions(currentFirmware, minEnterBootloader);
  if (relation === FIRMWARE_VERSION_RELATION.MALFORMED) {
    return {
      ok: false,
      manual: false,
      error:
        "Cannot decide bootloader entry path (malformed current or minDeviceFirmwareForEnterBootloader).",
    };
  }
  return {
    ok: true,
    // current older than minimum → no ENTER_BOOTLOADER on device
    manual: relation === FIRMWARE_VERSION_RELATION.OLDER,
  };
}

/**
 * Decide how to reach PICOBOOT after a prepared update.
 * Does not send commands — callers must not call ENTER_BOOTLOADER on "manual-bootsel".
 *
 * @param {{
 *   currentFirmware?: unknown,
 *   minEnterBootloader?: unknown,
 *   hasPicobootRp2040?: boolean,
 * }} state
 * @returns {{
 *   action: "flash-now" | "manual-bootsel" | "enter-bootloader" | "error",
 *   error?: string,
 * }}
 */
export function resolveFirmwareBootloaderEntry(state = {}) {
  if (state.hasPicobootRp2040) {
    return { action: "flash-now" };
  }
  const gate = requiresManualBootloaderEntry(
    state.currentFirmware,
    state.minEnterBootloader
  );
  if (!gate.ok) {
    return { action: "error", error: gate.error };
  }
  if (gate.manual) {
    return { action: "manual-bootsel" };
  }
  return { action: "enter-bootloader" };
}

/** User-facing copy for legacy / manual BOOTSEL waiting state. */
export const MANUAL_BOOTLOADER_INSTRUCTIONS = [
  "This firmware requires manual bootloader mode.",
  "",
  "1. Disconnect the USB cable.",
  "2. Hold the BOOTSEL button.",
  "3. Reconnect USB while holding BOOTSEL.",
  "4. Release BOOTSEL.",
].join("\n");

