/**
 * MP9 firmware distribution — manifest fetch, UF2 download, SHA-256 verify.
 *
 * Trust boundary: a SHA match only means downloaded bytes match the manifest
 * digest. It does NOT mean the UF2 is safe to flash. Callers must still run
 * Dry Run (buildFlashPlan → ACCEPT) before any erase/write.
 *
 * This module never imports flashPlan / flashProgram / picoboot.
 */

import {
  parseFirmwareManifest,
  resolveFirmwareUf2Url,
} from "./firmwareManifest.js";

/**
 * @typedef {import("./firmwareManifest.js").NormalizedFirmwareManifest} NormalizedFirmwareManifest
 */

/**
 * @typedef {object} FirmwareDistOptions
 * @property {typeof fetch} [fetch]
 * @property {{ subtle: { digest: (algorithm: AlgorithmIdentifier, data: BufferSource) => Promise<ArrayBuffer> } }} [crypto]
 */

/**
 * @typedef {object} VerifiedFirmwareDownload
 * @property {NormalizedFirmwareManifest} manifest
 * @property {ArrayBuffer} uf2Bytes
 * @property {string} sha256  Digested from uf2Bytes (lowercase hex).
 * @property {string} uf2Url  Resolved same-directory URL used for fetch.
 */

/**
 * @param {unknown} options
 * @returns {{ fetch: typeof fetch, crypto: { subtle: { digest: Function } } } | { error: string }}
 */
function resolveDeps(options = {}) {
  const injectedFetch =
    options && typeof options === "object" && "fetch" in options && options.fetch
      ? options.fetch
      : null;
  // Default must call through globalThis.fetch as a method. Storing the function
  // reference and invoking it detached throws Illegal invocation in browsers.
  const fetchImpl =
    injectedFetch ||
    (typeof globalThis.fetch === "function"
      ? (...args) => globalThis.fetch(...args)
      : null);
  const cryptoImpl =
    options && typeof options === "object" && "crypto" in options && options.crypto
      ? options.crypto
      : globalThis.crypto;

  if (typeof fetchImpl !== "function") {
    return { error: "fetch is not available" };
  }
  if (
    !cryptoImpl ||
    !cryptoImpl.subtle ||
    typeof cryptoImpl.subtle.digest !== "function"
  ) {
    return { error: "crypto.subtle.digest is not available" };
  }

  return { fetch: fetchImpl, crypto: cryptoImpl };
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export function bufferToSha256Hex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Digest UF2 (or any) bytes with Web Crypto SHA-256 → lowercase hex.
 *
 * @param {BufferSource} data
 * @param {FirmwareDistOptions} [options]
 * @returns {Promise<{ ok: true, sha256: string } | { ok: false, error: string }>}
 */
export async function digestSha256Hex(data, options = {}) {
  const deps = resolveDeps(options);
  if ("error" in deps) {
    return { ok: false, error: deps.error };
  }

  try {
    const digest = await deps.crypto.subtle.digest("SHA-256", data);
    return { ok: true, sha256: bufferToSha256Hex(digest) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `SHA-256 digest failed: ${message}` };
  }
}

/**
 * Normalize a manifest URL for fetch + same-directory UF2 resolve.
 *
 * Absolute URLs are left alone. Relative URLs are resolved against
 * `globalThis.location.href` when available (browser). Without a location
 * base (Node / DI tests), relative strings are returned unchanged so injected
 * fetch stubs keep matching.
 *
 * @param {string | URL} manifestUrl
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
function resolveEffectiveManifestUrl(manifestUrl) {
  const urlText = String(manifestUrl);
  if (!urlText) {
    return { ok: false, error: "manifestUrl is required" };
  }

  try {
    return { ok: true, url: new URL(urlText).href };
  } catch {
    // Relative or otherwise incomplete — try document location next.
  }

  const locationHref =
    typeof globalThis !== "undefined" &&
    globalThis.location &&
    typeof globalThis.location.href === "string" &&
    globalThis.location.href
      ? globalThis.location.href
      : null;

  if (locationHref) {
    try {
      return { ok: true, url: new URL(urlText, locationHref).href };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `invalid manifestUrl: ${message}` };
    }
  }

  return { ok: true, url: urlText };
}

/**
 * Fetch and validate a firmware manifest JSON document.
 *
 * On success, `manifestUrl` is the effective absolute URL used for fetch
 * (relative inputs resolved against `location.href` in the browser) so
 * downstream same-directory UF2 resolve has a valid base.
 *
 * Manifest fetch always passes `{ cache: "no-store" }` (default and DI)
 * so published latest is not served from the browser HTTP cache.
 *
 * @param {string | URL} manifestUrl
 * @param {FirmwareDistOptions} [options]
 * @returns {Promise<{ ok: true, manifest: NormalizedFirmwareManifest, manifestUrl: string } | { ok: false, error: string }>}
 */
export async function fetchFirmwareManifest(manifestUrl, options = {}) {
  const deps = resolveDeps(options);
  if ("error" in deps) {
    return { ok: false, error: deps.error };
  }

  const resolved = resolveEffectiveManifestUrl(manifestUrl);
  if (!resolved.ok) {
    return resolved;
  }
  const urlText = resolved.url;
  // Always bypass HTTP cache for the latest manifest so Check for Update
  // sees newly published versions. Do not mutate urlText — UF2 resolve uses
  // it as the same-directory base. UF2 download keeps default fetch caching.
  const manifestFetchInit = Object.freeze({ cache: "no-store" });

  let response;
  try {
    response = await deps.fetch(urlText, manifestFetchInit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `manifest fetch failed: ${message}` };
  }

  if (!response || response.ok !== true) {
    const status = response && typeof response.status === "number" ? response.status : "?";
    return { ok: false, error: `manifest fetch HTTP ${status}` };
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `manifest JSON parse failed: ${message}` };
  }

  const parsed = parseFirmwareManifest(json);
  if (!parsed.ok) {
    return { ok: false, error: `invalid manifest: ${parsed.error}` };
  }

  return {
    ok: true,
    manifest: parsed.manifest,
    manifestUrl: urlText,
  };
}

/**
 * Fetch manifest, download same-directory UF2, verify SHA-256 of actual bytes.
 *
 * Does not flash. SHA match ≠ flash-safe; Dry Run ACCEPT is still required.
 *
 * @param {string | URL} manifestUrl
 * @param {FirmwareDistOptions} [options]
 * @returns {Promise<{ ok: true, download: VerifiedFirmwareDownload } | { ok: false, error: string }>}
 */
export async function downloadAndVerifyFirmware(manifestUrl, options = {}) {
  const deps = resolveDeps(options);
  if ("error" in deps) {
    return { ok: false, error: deps.error };
  }

  const fetched = await fetchFirmwareManifest(manifestUrl, options);
  if (!fetched.ok) {
    return fetched;
  }

  const { manifest, manifestUrl: baseUrl } = fetched;

  let uf2Url;
  try {
    uf2Url = resolveFirmwareUf2Url(baseUrl, manifest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `UF2 URL resolve failed: ${message}` };
  }

  let response;
  try {
    response = await deps.fetch(uf2Url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `UF2 fetch failed: ${message}` };
  }

  if (!response || response.ok !== true) {
    const status = response && typeof response.status === "number" ? response.status : "?";
    return { ok: false, error: `UF2 fetch HTTP ${status}` };
  }

  let uf2Bytes;
  try {
    uf2Bytes = await response.arrayBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `UF2 body read failed: ${message}` };
  }

  if (!(uf2Bytes instanceof ArrayBuffer) || uf2Bytes.byteLength === 0) {
    return { ok: false, error: "UF2 download is empty" };
  }

  const digested = await digestSha256Hex(uf2Bytes, options);
  if (!digested.ok) {
    return digested;
  }

  if (digested.sha256 !== manifest.sha256) {
    return {
      ok: false,
      error: "UF2 SHA-256 does not match manifest.sha256",
    };
  }

  /** @type {VerifiedFirmwareDownload} */
  const download = Object.freeze({
    manifest,
    uf2Bytes,
    sha256: digested.sha256,
    uf2Url,
  });

  return { ok: true, download };
}

/** Alias matching the design report naming. */
export const fetchAndVerifyFirmwareDistribution = downloadAndVerifyFirmware;
