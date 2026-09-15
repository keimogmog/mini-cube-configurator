/**
 * Firmware update integration — distribution → flash plan → flash program.
 *
 * Orchestration only. Does not reimplement download, Dry Run, or erase/write.
 * UI / DOM free. SHA match ≠ flash-safe; Dry Run ACCEPT is still required.
 */

import { downloadAndVerifyFirmware } from "./firmwareDist.js";
import { buildFlashPlan } from "./flashPlan.js";
import { programAcceptedFlashPlan } from "./flashProgram.js";

/**
 * @typedef {import("./firmwareDist.js").VerifiedFirmwareDownload} VerifiedFirmwareDownload
 * @typedef {import("./firmwareDist.js").FirmwareDistOptions} FirmwareDistOptions
 */

/**
 * @typedef {FirmwareDistOptions & {
 *   productId?: number | null,
 *   connected?: boolean,
 *   downloadAndVerifyFirmware?: typeof downloadAndVerifyFirmware,
 *   buildFlashPlan?: typeof buildFlashPlan,
 *   programAcceptedFlashPlan?: typeof programAcceptedFlashPlan,
 *   eepromBytes?: Uint8Array,
 *   livePlan?: object,
 *   onProgress?: Function,
 * }} FirmwareUpdateOptions
 */

/**
 * @typedef {object} PreparedFirmwareUpdate
 * @property {VerifiedFirmwareDownload} download
 * @property {object} plan  Result of buildFlashPlan (Dry Run; may be ACCEPT).
 * @property {string} fileName  Manifest UF2 filename for programAcceptedFlashPlan.
 */

/**
 * Resolve injectable hooks while preserving dist fetch/crypto options.
 *
 * @param {FirmwareUpdateOptions} [options]
 */
function resolveHooks(options = {}) {
  return {
    downloadAndVerifyFirmware:
      options.downloadAndVerifyFirmware || downloadAndVerifyFirmware,
    buildFlashPlan: options.buildFlashPlan || buildFlashPlan,
    programAcceptedFlashPlan:
      options.programAcceptedFlashPlan || programAcceptedFlashPlan,
  };
}

/**
 * Download + verify UF2, then build a Dry Run flash plan. Does not write flash.
 *
 * @param {string | URL} manifestUrl
 * @param {FirmwareUpdateOptions} [options]
 * @returns {Promise<
 *   | { ok: true, prepared: PreparedFirmwareUpdate }
 *   | { ok: false, error: string, download?: VerifiedFirmwareDownload, plan?: object }
 * >}
 */
export async function prepareFirmwareUpdate(manifestUrl, options = {}) {
  const hooks = resolveHooks(options);

  const distributed = await hooks.downloadAndVerifyFirmware(manifestUrl, options);
  if (!distributed.ok) {
    return distributed;
  }

  const { download } = distributed;
  const plan = hooks.buildFlashPlan(download.uf2Bytes, {
    productId: options.productId,
    connected: options.connected,
  });

  if (!plan || plan.ok !== true) {
    return {
      ok: false,
      error: "flash plan rejected (Dry Run REJECT)",
      download,
      plan,
    };
  }

  /** @type {PreparedFirmwareUpdate} */
  const prepared = Object.freeze({
    download,
    plan,
    fileName: download.manifest.uf2,
  });

  return { ok: true, prepared };
}

/**
 * Full orchestration: verify distribution → ACCEPT plan → programAcceptedFlashPlan.
 *
 * Flash write logic stays in flashProgram.js. Failures before program leave the
 * device untouched. Dist / plan errors are returned as-is (fail closed).
 *
 * @param {string | URL} manifestUrl
 * @param {object} session  Claimed PICOBOOT session (passed to programAcceptedFlashPlan).
 * @param {FirmwareUpdateOptions} [options]
 * @returns {Promise<
 *   | { ok: true, prepared: PreparedFirmwareUpdate, program: object }
 *   | { ok: false, error: string, download?: VerifiedFirmwareDownload, plan?: object }
 * >}
 */
export async function performFirmwareUpdate(manifestUrl, session, options = {}) {
  const hooks = resolveHooks(options);

  const productId =
    options.productId != null
      ? options.productId
      : session && session.info
        ? session.info.productId
        : undefined;

  const preparedResult = await prepareFirmwareUpdate(manifestUrl, {
    ...options,
    productId,
    connected:
      options.connected != null
        ? options.connected
        : productId === 0x0003 || productId === 0x000f,
  });
  if (!preparedResult.ok) {
    return preparedResult;
  }

  const { prepared } = preparedResult;
  const eepromBytes = options.eepromBytes;
  if (!(eepromBytes instanceof Uint8Array)) {
    return {
      ok: false,
      error: "eepromBytes is required before flash",
      download: prepared.download,
      plan: prepared.plan,
    };
  }

  const livePlan =
    options.livePlan ||
    hooks.buildFlashPlan(prepared.download.uf2Bytes, {
      productId,
      connected: true,
    });

  const program = await hooks.programAcceptedFlashPlan(
    session,
    {
      plan: prepared.plan,
      fileName: prepared.fileName,
      eepromBytes,
      livePlan,
    },
    { onProgress: options.onProgress }
  );

  return {
    ok: true,
    prepared,
    program,
  };
}
