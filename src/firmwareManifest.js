/**
 * MP9 firmware distribution manifest — parse + schema validation only.
 *
 * Does not fetch, download UF2, hash bytes, or flash. Callers must still
 * verify downloaded UF2 bytes (SHA-256 + Dry Run ACCEPT) before programming.
 *
 * URL policy: `uf2` filename is canonical. `uf2Url` is accepted only when it is
 * a same-directory relative reference to that exact filename (no schemes,
 * absolute paths, or parent traversal). Normalized output always exposes
 * `uf2Url` as `./<uf2>` so callers resolve against the manifest base URL.
 */

import { parseFirmwareVersion } from "./versionCompare.js";

export const FIRMWARE_MANIFEST_SCHEMA_VERSION = 1;
export const FIRMWARE_MANIFEST_DEVICE = "MP9";
export const FIRMWARE_MANIFEST_HARDWARE = "V1";
export const FIRMWARE_MANIFEST_UF2_FAMILY = "0xE48BFF56";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const UF2_RELEASE_FILENAME_RE =
  /^MP9_V1-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.uf2$/;
/** Strict ISO-8601 timestamps (date-time with timezone). */
const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * @typedef {object} NormalizedFirmwareManifest
 * @property {1} schemaVersion
 * @property {"MP9"} device
 * @property {"V1"} hardware
 * @property {string} version
 * @property {string} uf2
 * @property {string} uf2Url  Always `./${uf2}` after validation.
 * @property {string} sha256
 * @property {"0xE48BFF56"} uf2Family
 * @property {string} minConfiguratorVersion
 * @property {string} minDeviceFirmwareForEnterBootloader
 * @property {string} releaseNotes
 * @property {string} publishedAt
 */

/**
 * @param {unknown} value
 * @returns {{ ok: true, manifest: NormalizedFirmwareManifest } | { ok: false, error: string }}
 */
export function parseFirmwareManifest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("manifest must be a plain object");
  }

  /** @type {Record<string, unknown>} */
  const raw = value;

  if (raw.schemaVersion !== FIRMWARE_MANIFEST_SCHEMA_VERSION) {
    return fail("schemaVersion must be 1");
  }
  if (raw.device !== FIRMWARE_MANIFEST_DEVICE) {
    return fail('device must be "MP9"');
  }
  if (raw.hardware !== FIRMWARE_MANIFEST_HARDWARE) {
    return fail('hardware must be "V1"');
  }

  const version = requireStrictVersion(raw.version, "version");
  if (!version.ok) {
    return version;
  }

  if (typeof raw.uf2 !== "string") {
    return fail("uf2 must be a string");
  }
  const uf2Match = UF2_RELEASE_FILENAME_RE.exec(raw.uf2);
  if (!uf2Match) {
    return fail(
      'uf2 must match MP9_V1-<major>.<minor>.<patch>.uf2 (Arduino MP9_V1.ino.uf2 is not accepted)'
    );
  }
  if (uf2Match[1] !== version.value) {
    return fail("uf2 filename version must match manifest.version");
  }

  if (typeof raw.uf2Url !== "string") {
    return fail("uf2Url must be a string");
  }
  if (!isSafeSameDirectoryUf2Url(raw.uf2Url, raw.uf2)) {
    return fail(
      "uf2Url must be a same-directory relative path to the uf2 filename"
    );
  }

  if (typeof raw.sha256 !== "string" || !SHA256_HEX_RE.test(raw.sha256)) {
    return fail("sha256 must be exactly 64 lowercase hex characters");
  }

  if (raw.uf2Family !== FIRMWARE_MANIFEST_UF2_FAMILY) {
    return fail(`uf2Family must be "${FIRMWARE_MANIFEST_UF2_FAMILY}"`);
  }

  const minConfiguratorVersion = requireStrictVersion(
    raw.minConfiguratorVersion,
    "minConfiguratorVersion"
  );
  if (!minConfiguratorVersion.ok) {
    return minConfiguratorVersion;
  }

  const minDeviceFirmwareForEnterBootloader = requireStrictVersion(
    raw.minDeviceFirmwareForEnterBootloader,
    "minDeviceFirmwareForEnterBootloader"
  );
  if (!minDeviceFirmwareForEnterBootloader.ok) {
    return minDeviceFirmwareForEnterBootloader;
  }

  if (typeof raw.releaseNotes !== "string") {
    return fail("releaseNotes must be a string");
  }

  if (typeof raw.publishedAt !== "string" || !isValidIsoTimestamp(raw.publishedAt)) {
    return fail("publishedAt must be a valid ISO-8601 timestamp");
  }

  /** @type {NormalizedFirmwareManifest} */
  const manifest = Object.freeze({
    schemaVersion: FIRMWARE_MANIFEST_SCHEMA_VERSION,
    device: FIRMWARE_MANIFEST_DEVICE,
    hardware: FIRMWARE_MANIFEST_HARDWARE,
    version: version.value,
    uf2: raw.uf2,
    uf2Url: `./${raw.uf2}`,
    sha256: raw.sha256,
    uf2Family: FIRMWARE_MANIFEST_UF2_FAMILY,
    minConfiguratorVersion: minConfiguratorVersion.value,
    minDeviceFirmwareForEnterBootloader:
      minDeviceFirmwareForEnterBootloader.value,
    releaseNotes: raw.releaseNotes,
    publishedAt: raw.publishedAt,
  });

  return { ok: true, manifest };
}

/**
 * Build a same-directory UF2 URL from a validated manifest and the manifest's base URL.
 * Never uses caller-supplied absolute/external URLs.
 *
 * @param {string | URL} manifestBaseUrl  URL of the manifest document (…/manifest.json).
 * @param {Pick<NormalizedFirmwareManifest, "uf2">} manifest
 * @returns {string}
 */
export function resolveFirmwareUf2Url(manifestBaseUrl, manifest) {
  if (!manifest || typeof manifest.uf2 !== "string") {
    throw new Error("resolveFirmwareUf2Url: invalid manifest");
  }
  if (!UF2_RELEASE_FILENAME_RE.test(manifest.uf2)) {
    throw new Error("resolveFirmwareUf2Url: uf2 filename is not a release name");
  }
  return new URL(`./${manifest.uf2}`, manifestBaseUrl).href;
}

/**
 * @param {unknown} value
 * @param {string} expectedFilename
 * @returns {boolean}
 */
export function isSafeSameDirectoryUf2Url(value, expectedFilename) {
  if (typeof value !== "string" || typeof expectedFilename !== "string") {
    return false;
  }
  if (value.length === 0 || expectedFilename.length === 0) {
    return false;
  }
  // Fail closed on encoding / control / separator tricks.
  if (/[\0-\x1f\x7f\\?#%]/.test(value)) {
    return false;
  }
  if (value.includes("..")) {
    return false;
  }
  // Schemes and protocol-relative URLs.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith("//")) {
    return false;
  }
  // Absolute path or nested relative path.
  if (value.startsWith("/") || value.includes("/")) {
    // Allow only exactly "./<filename>" (single "./" prefix, no further slashes).
    if (value === `./${expectedFilename}`) {
      return true;
    }
    return false;
  }
  return value === expectedFilename;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isMp9V1ReleaseUf2Filename(value) {
  return typeof value === "string" && UF2_RELEASE_FILENAME_RE.test(value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
function requireStrictVersion(value, field) {
  if (parseFirmwareVersion(value) === null) {
    return fail(`${field} must be a strict major.minor.patch version`);
  }
  return { ok: true, value: /** @type {string} */ (value) };
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isValidIsoTimestamp(value) {
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  // Wall-clock Y-M-D in the string must be a real calendar date.
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  ) {
    return false;
  }

  return Number.isFinite(Date.parse(value));
}

/**
 * @param {string} error
 * @returns {{ ok: false, error: string }}
 */
function fail(error) {
  return { ok: false, error };
}
