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
export const MF5_FIRMWARE_MANIFEST_URL = "./firmware/mf5/latest/manifest.json";

/**
 * @param {{ id?: string, displayName?: string, firmwareManifestUrl?: string } | null | undefined} profile
 * @returns {string}
 */
export function firmwareManifestUrlForProfile(profile) {
  if (profile && typeof profile.firmwareManifestUrl === "string" && profile.firmwareManifestUrl) {
    return profile.firmwareManifestUrl;
  }
  if (profile?.id === "mf5" || profile?.displayName === "MF5") {
    return MF5_FIRMWARE_MANIFEST_URL;
  }
  return DEFAULT_FIRMWARE_MANIFEST_URL;
}

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
      detail: "Couldn't read the firmware version.",
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

/** Label for the WebUSB gesture button (id unchanged). */
export const FIRMWARE_UPDATE_CONTINUE_LABEL = "Continue";

/** Label for the post-error re-check button (id unchanged). */
export const FIRMWARE_UPDATE_TRY_AGAIN_LABEL = "Try again";

/** Waiting for the Continue gesture. */
export const PRODUCT_CONTINUE_GUIDANCE = "Click Continue, then select RP2 Boot.";

/** Shown after Continue, while the browser USB chooser is open. */
export const PRODUCT_SELECT_RP2_GUIDANCE = "Select RP2 Boot in the browser window.";

/** Flash erase/write in progress (primary). */
export const PRODUCT_WRITING_GUIDANCE = "Writing firmware…";

/** Cable tip shown with writing progress. */
export const PRODUCT_KEEP_USB_CONNECTED = "Keep the USB cable connected.";

/** Writing primary + cable tip for the panel (two lines). */
export const PRODUCT_WRITING_PANEL_MESSAGE = `${PRODUCT_WRITING_GUIDANCE}\n${PRODUCT_KEEP_USB_CONNECTED}`;

/** Page / EEPROM verify in progress. */
export const PRODUCT_VERIFYING_GUIDANCE = "Verifying…";

/** Reboot after verified flash. */
export const PRODUCT_RESTARTING_GUIDANCE = "Restarting…";

/** Waiting for MIDI auto-reconnect after reboot. */
export const PRODUCT_RECONNECTING_GUIDANCE = "Reconnecting automatically…";

/** Download / prepare before bootloader entry. */
export const PRODUCT_PREPARING_GUIDANCE = "Preparing…";

/** ENTER_BOOTLOADER in progress. */
export const PRODUCT_ENTERING_UPDATE_MODE_GUIDANCE = "Entering update mode…";

/** User cancelled the browser USB picker. */
export const PRODUCT_USB_CANCELLED_GUIDANCE =
  "USB access was cancelled. Click Continue and select RP2 Boot.";

/** ENTER_BOOTLOADER / SysEx timeout / command reject while still on MIDI. */
export const PRODUCT_ENTER_UPDATE_MODE_FAILED_GUIDANCE =
  "Couldn't enter update mode. Keep the USB cable connected and try again.";

/** Manifest / UF2 network download failure. */
export const PRODUCT_DOWNLOAD_FAILED_GUIDANCE =
  "Couldn't download the update. Check your internet connection and try again.";

/**
 * Post-update success copy for the Firmware Update panel.
 * Presentation only.
 *
 * @param {unknown} version
 * @returns {string}
 */
export function firmwareUpdateSuccessMessage(version) {
  const value = version == null ? "" : String(version).trim();
  if (value && value !== "—") {
    return `Firmware updated to ${value}`;
  }
  return "Firmware updated.";
}

/**
 * Whether global Status should yield to the Firmware Update panel.
 * Presentation only — in-flight update / error phases (not quiet version check).
 *
 * @param {string} phase
 * @returns {boolean}
 */
export function shouldSuppressGlobalStatusForFirmwareUpdate(phase) {
  const value = formatFirmwareUpdatePhase(phase);
  return (
    value === FW_UPDATE_UI_PHASE.DOWNLOADING ||
    value === FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER ||
    value === FW_UPDATE_UI_PHASE.FLASHING ||
    value === FW_UPDATE_UI_PHASE.ERROR
  );
}

/**
 * Restore a normal connection Status after Firmware Update panel work.
 * Presentation only.
 *
 * @param {{ displayName?: string } | null | undefined} profile
 * @returns {string}
 */
export function connectedStatusMessage(profile) {
  const name = profile && profile.displayName ? String(profile.displayName).trim() : "";
  return name ? `${name} connected` : "";
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
      return "Connect your mini cube to check for updates.";
    }
  }

  switch (value) {
    case FW_UPDATE_UI_PHASE.CHECKING:
      return "Checking for updates…";
    case FW_UPDATE_UI_PHASE.UP_TO_DATE:
      return "Firmware is up to date.";
    case FW_UPDATE_UI_PHASE.UPDATE_AVAILABLE:
      return "";
    case FW_UPDATE_UI_PHASE.DOWNLOADING:
      return PRODUCT_PREPARING_GUIDANCE;
    case FW_UPDATE_UI_PHASE.WAITING_BOOTLOADER:
      return PRODUCT_CONTINUE_GUIDANCE;
    case FW_UPDATE_UI_PHASE.FLASHING:
      return PRODUCT_WRITING_PANEL_MESSAGE;
    case FW_UPDATE_UI_PHASE.SUCCESS:
      return "Firmware updated.";
    case FW_UPDATE_UI_PHASE.ERROR:
      return "";
    case FW_UPDATE_UI_PHASE.IDLE:
    default:
      return connected ? "" : "Connect your mini cube to check for updates.";
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
 * Map flashProgram onProgress phases to short product copy.
 * Presentation only — does not change flash behavior.
 *
 * @param {unknown} phase
 * @returns {string}
 */
export function firmwareUpdateFlashProgressMessage(phase) {
  const value = String(phase || "");
  if (
    value === "verify" ||
    value === "eeprom-check" ||
    value === "verified"
  ) {
    return PRODUCT_VERIFYING_GUIDANCE;
  }
  return PRODUCT_WRITING_PANEL_MESSAGE;
}

/**
 * Soften technical updater errors for the normal Firmware Update panel.
 * Presentation only — callers should still keep raw messages in console / debug logs.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function firmwareUpdateUserFacingDetail(raw) {
  const message = raw == null ? "" : String(raw).trim();
  if (!message) {
    return "";
  }
  if (/SHA-256|sha256/i.test(message)) {
    return "The update file could not be verified.";
  }
  if (/Dry Run REJECT|flash plan rejected|not compatible/i.test(message)) {
    return "This update is not compatible.";
  }
  if (/eeprom|verify failed|VERIFY FAIL|page verify/i.test(message)) {
    return "Update could not be verified. Try again.";
  }
  if (/NotFoundError|cancelled|User cancelled|AbortError/i.test(message)) {
    return PRODUCT_USB_CANCELLED_GUIDANCE;
  }
  // ENTER_BOOTLOADER / SysEx path failures (before or without leaving MIDI).
  if (
    /ENTER_BOOTLOADER|enter bootloader|enter update mode/i.test(message) ||
    /Timed out waiting for the device/i.test(message) ||
    /Device rejected command 0x0*6\b/i.test(message) ||
    /command 0x0*6\b/i.test(message) ||
    /\bNACK\b/i.test(message) ||
    /configurator firmware loaded/i.test(message)
  ) {
    return PRODUCT_ENTER_UPDATE_MODE_FAILED_GUIDANCE;
  }
  if (
    /manifest fetch|UF2 fetch|UF2 URL resolve|UF2 body read|UF2 download is empty|Failed to fetch|NetworkError|Load failed|invalid manifest|manifest JSON parse/i.test(
      message
    )
  ) {
    return PRODUCT_DOWNLOAD_FAILED_GUIDANCE;
  }
  if (/malformed|Couldn't read the firmware version/i.test(message)) {
    return "Couldn't read the firmware version.";
  }
  if (/does not match/i.test(message)) {
    return "This update is for a different device.";
  }
  if (/Bootloader session|prepared update missing|prepared update/i.test(message)) {
    return "Update session was lost. Try again.";
  }
  if (/MIDI session required|Device is not connected|MIDI output is not available/i.test(message)) {
    return "Connect your mini cube, then try again.";
  }
  if (/WebUSB|crypto\.subtle|fetch is not available/i.test(message)) {
    return "Use Chrome or Edge to update firmware.";
  }
  return "Something went wrong. Try again.";
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
      error: "Couldn't read the firmware version.",
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

/**
 * User-facing copy for legacy / manual BOOTSEL waiting state.
 * Shown only when currentFirmware < minDeviceFirmwareForEnterBootloader.
 * Shipping units on ENTER_BOOTLOADER-capable firmware must never see this.
 */
export const MANUAL_BOOTLOADER_INSTRUCTIONS = [
  "This device is running an older firmware that cannot enter update mode automatically.",
  "Manual BOOTSEL is required only for this older firmware.",
  "",
  "1. Disconnect the USB cable.",
  "2. Hold the BOOTSEL button.",
  "3. Reconnect USB while holding BOOTSEL.",
  "4. Release BOOTSEL.",
  "5. Click Continue, then select RP2 Boot.",
].join("\n");
