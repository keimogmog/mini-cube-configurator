/**
 * Strict firmware version comparison for MP9 update UX.
 *
 * Accepts only major.minor.patch where each component is a non-negative
 * integer with no leading zeros, and is Number.isSafeInteger-safe.
 *
 * This module compares only. Update / downgrade UI policy belongs to callers:
 *   older  → update available
 *   equal  → up to date
 *   newer  → device is newer (do not propose downgrade)
 *   malformed → fail closed (do not judge update)
 */

export const FIRMWARE_VERSION_RELATION = Object.freeze({
  OLDER: "older",
  EQUAL: "equal",
  NEWER: "newer",
  MALFORMED: "malformed",
});

const STRICT_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * @param {unknown} value
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
export function parseFirmwareVersion(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = STRICT_VERSION_RE.exec(value);
  if (!match) {
    return null;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch) ||
    major < 0 ||
    minor < 0 ||
    patch < 0
  ) {
    return null;
  }

  return { major, minor, patch };
}

/**
 * Compare two firmware versions.
 *
 * @param {unknown} current
 * @param {unknown} latest
 * @returns {"older" | "equal" | "newer" | "malformed"}
 */
export function compareFirmwareVersions(current, latest) {
  const a = parseFirmwareVersion(current);
  const b = parseFirmwareVersion(latest);
  if (!a || !b) {
    return FIRMWARE_VERSION_RELATION.MALFORMED;
  }

  if (a.major !== b.major) {
    return a.major < b.major
      ? FIRMWARE_VERSION_RELATION.OLDER
      : FIRMWARE_VERSION_RELATION.NEWER;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor
      ? FIRMWARE_VERSION_RELATION.OLDER
      : FIRMWARE_VERSION_RELATION.NEWER;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch
      ? FIRMWARE_VERSION_RELATION.OLDER
      : FIRMWARE_VERSION_RELATION.NEWER;
  }
  return FIRMWARE_VERSION_RELATION.EQUAL;
}
