import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  downloadAndVerifyFirmware,
  digestSha256Hex,
  fetchFirmwareManifest,
} from "../src/firmwareDist.js";
import { FIRMWARE_MANIFEST_UF2_FAMILY } from "../src/firmwareManifest.js";

const MANIFEST_URL =
  "https://example.github.io/app/firmware/latest/manifest.json";
const EXPECTED_UF2_URL =
  "https://example.github.io/app/firmware/latest/MP9_V1-0.3.1.uf2";

function hexFromDigest(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Of(bytes) {
  const digest = await webcrypto.subtle.digest("SHA-256", bytes);
  return hexFromDigest(digest);
}

function validManifestJson(sha256, overrides = {}) {
  return {
    schemaVersion: 1,
    device: "MP9",
    hardware: "V1",
    version: "0.3.1",
    uf2: "MP9_V1-0.3.1.uf2",
    uf2Url: "./MP9_V1-0.3.1.uf2",
    sha256,
    uf2Family: FIRMWARE_MANIFEST_UF2_FAMILY,
    minConfiguratorVersion: "0.0.0",
    minDeviceFirmwareForEnterBootloader: "0.3.0",
    releaseNotes: "notes",
    publishedAt: "2026-09-15T00:00:00Z",
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (typeof body === "string") {
        return JSON.parse(body);
      }
      return body;
    },
    async arrayBuffer() {
      throw new Error("not a binary response");
    },
  };
}

function binaryResponse(status, bytes) {
  const buffer =
    bytes instanceof ArrayBuffer
      ? bytes
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      throw new Error("not JSON");
    },
    async arrayBuffer() {
      return buffer;
    },
  };
}

function makeFetchStub(routes) {
  const calls = [];
  const inits = [];
  const fetchStub = async (url, init) => {
    const key = String(url);
    calls.push(key);
    inits.push(init);
    if (typeof routes[key] === "function") {
      return routes[key]();
    }
    if (routes[key]) {
      return routes[key];
    }
    throw new Error(`unexpected fetch: ${key}`);
  };
  return { fetchStub, calls, inits };
}

async function assertReject(promise, label) {
  const result = await promise;
  assert.equal(result.ok, false, `expected reject: ${label}`);
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0, `expected error: ${label}`);
  return result;
}

// --- digest helper ---
{
  const bytes = new Uint8Array([1, 2, 3, 4, 255, 0, 128]).buffer;
  const expected = await sha256Of(bytes);
  const result = await digestSha256Hex(bytes, { crypto: webcrypto });
  assert.equal(result.ok, true);
  assert.equal(result.sha256, expected);
  assert.equal(result.sha256, result.sha256.toLowerCase());
  assert.equal(result.sha256.length, 64);
}

// --- PASS: valid manifest + matching UF2 ---
{
  const uf2Bytes = new Uint8Array([0x55, 0x46, 0x32, 0x0a, 0x00, 0xff, 0x10]).buffer;
  const sha256 = await sha256Of(uf2Bytes);
  const { fetchStub, calls } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(sha256)),
    [EXPECTED_UF2_URL]: binaryResponse(200, uf2Bytes),
  });

  const result = await downloadAndVerifyFirmware(MANIFEST_URL, {
    fetch: fetchStub,
    crypto: webcrypto,
  });

  assert.equal(result.ok, true);
  assert.equal(result.download.sha256, sha256);
  assert.equal(result.download.uf2Url, EXPECTED_UF2_URL);
  assert.equal(result.download.manifest.version, "0.3.1");
  assert.equal(result.download.uf2Bytes.byteLength, uf2Bytes.byteLength);
  assert.deepEqual(
    [...new Uint8Array(result.download.uf2Bytes)],
    [...new Uint8Array(uf2Bytes)]
  );
  assert.deepEqual(calls, [MANIFEST_URL, EXPECTED_UF2_URL]);
}

// --- PASS: nontrivial binary + same-directory resolution ---
{
  const uf2Bytes = new Uint8Array(512);
  for (let i = 0; i < uf2Bytes.length; i += 1) {
    uf2Bytes[i] = (i * 37 + 11) & 0xff;
  }
  const sha256 = await sha256Of(uf2Bytes.buffer);
  const { fetchStub, calls } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(
      200,
      validManifestJson(sha256, { uf2Url: "MP9_V1-0.3.1.uf2" })
    ),
    [EXPECTED_UF2_URL]: binaryResponse(200, uf2Bytes),
  });

  const result = await downloadAndVerifyFirmware(MANIFEST_URL, {
    fetch: fetchStub,
    crypto: webcrypto,
  });
  assert.equal(result.ok, true);
  assert.equal(result.download.uf2Url, EXPECTED_UF2_URL);
  assert.equal(result.download.sha256, sha256);
  assert.equal(calls[1], EXPECTED_UF2_URL);
  assert.ok(!calls.some((u) => u.includes("evil") || u.includes("..")));
}

// --- PASS: fetchFirmwareManifest alone ---
{
  const sha256 = "a".repeat(64);
  const { fetchStub, inits } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(sha256)),
  });
  const result = await fetchFirmwareManifest(MANIFEST_URL, {
    fetch: fetchStub,
    crypto: webcrypto,
  });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.uf2, "MP9_V1-0.3.1.uf2");
  assert.equal(result.manifestUrl, MANIFEST_URL);
  assert.deepEqual(inits, [{ cache: "no-store" }]);
}

// --- PASS: manifest fetch uses cache:"no-store"; UF2 fetch does not ---
{
  const uf2Bytes = new Uint8Array([9, 8, 7, 6]).buffer;
  const sha256 = await sha256Of(uf2Bytes);
  const { fetchStub, calls, inits } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(sha256)),
    [EXPECTED_UF2_URL]: binaryResponse(200, uf2Bytes),
  });
  const result = await downloadAndVerifyFirmware(MANIFEST_URL, {
    fetch: fetchStub,
    crypto: webcrypto,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [MANIFEST_URL, EXPECTED_UF2_URL]);
  assert.deepEqual(inits[0], { cache: "no-store" });
  assert.equal(inits[1], undefined, "UF2 fetch must keep default cache behavior");
  assert.equal(result.download.uf2Url, EXPECTED_UF2_URL);
  // Effective base used for UF2 resolve is unchanged (no cache-bust query).
  assert.equal(result.download.uf2Url.includes("?"), false);
}

// --- REJECT: manifest fetch non-OK ---
{
  const { fetchStub } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(404, { error: "missing" }),
  });
  await assertReject(
    downloadAndVerifyFirmware(MANIFEST_URL, {
      fetch: fetchStub,
      crypto: webcrypto,
    }),
    "manifest HTTP 404"
  );
}

// --- REJECT: malformed JSON ---
{
  const { fetchStub } = makeFetchStub({
    [MANIFEST_URL]: {
      ok: true,
      status: 200,
      async json() {
        throw new SyntaxError("Unexpected token");
      },
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
    },
  });
  await assertReject(
    downloadAndVerifyFirmware(MANIFEST_URL, {
      fetch: fetchStub,
      crypto: webcrypto,
    }),
    "malformed JSON"
  );
}

// --- REJECT: invalid manifest ---
{
  const { fetchStub } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, {
      schemaVersion: 1,
      device: "WRONG",
    }),
  });
  await assertReject(
    downloadAndVerifyFirmware(MANIFEST_URL, {
      fetch: fetchStub,
      crypto: webcrypto,
    }),
    "invalid manifest"
  );
}

// --- REJECT: uppercase SHA in manifest (validator) ---
{
  const uf2Bytes = new Uint8Array([1, 2, 3]).buffer;
  const upper = (await sha256Of(uf2Bytes)).toUpperCase();
  const { fetchStub, calls } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(upper)),
    [EXPECTED_UF2_URL]: binaryResponse(200, uf2Bytes),
  });
  await assertReject(
    downloadAndVerifyFirmware(MANIFEST_URL, {
      fetch: fetchStub,
      crypto: webcrypto,
    }),
    "uppercase SHA manifest"
  );
  assert.deepEqual(calls, [MANIFEST_URL], "must not fetch UF2 after invalid manifest");
}

// --- REJECT: UF2 fetch non-OK ---
{
  const sha256 = "b".repeat(64);
  const { fetchStub } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(sha256)),
    [EXPECTED_UF2_URL]: binaryResponse(500, new Uint8Array([1])),
  });
  await assertReject(
    downloadAndVerifyFirmware(MANIFEST_URL, {
      fetch: fetchStub,
      crypto: webcrypto,
    }),
    "UF2 HTTP 500"
  );
}

// --- REJECT: empty UF2 ---
{
  const empty = new ArrayBuffer(0);
  const sha256 = await sha256Of(empty);
  const { fetchStub } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(sha256)),
    [EXPECTED_UF2_URL]: binaryResponse(200, empty),
  });
  await assertReject(
    downloadAndVerifyFirmware(MANIFEST_URL, {
      fetch: fetchStub,
      crypto: webcrypto,
    }),
    "empty UF2"
  );
}

// --- REJECT: SHA mismatch ---
{
  const uf2Bytes = new Uint8Array([9, 8, 7, 6]).buffer;
  const wrongSha = "c".repeat(64);
  const { fetchStub } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(wrongSha)),
    [EXPECTED_UF2_URL]: binaryResponse(200, uf2Bytes),
  });
  const result = await assertReject(
    downloadAndVerifyFirmware(MANIFEST_URL, {
      fetch: fetchStub,
      crypto: webcrypto,
    }),
    "SHA mismatch"
  );
  assert.match(result.error, /SHA-256/i);
}

// --- REJECT: crypto failure ---
{
  const uf2Bytes = new Uint8Array([1]).buffer;
  const sha256 = await sha256Of(uf2Bytes);
  const { fetchStub } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(sha256)),
    [EXPECTED_UF2_URL]: binaryResponse(200, uf2Bytes),
  });
  await assertReject(
    downloadAndVerifyFirmware(MANIFEST_URL, {
      fetch: fetchStub,
      crypto: {
        subtle: {
          async digest() {
            throw new Error("subtle broken");
          },
        },
      },
    }),
    "crypto failure"
  );
}

// --- REJECT: fetch failure (network throw) ---
{
  const fetchStub = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assertReject(
    downloadAndVerifyFirmware(MANIFEST_URL, {
      fetch: fetchStub,
      crypto: webcrypto,
    }),
    "fetch failure"
  );
}

// --- SAFETY: never fetch external / traversal URLs from manifest fields ---
{
  const uf2Bytes = new Uint8Array([4, 5, 6]).buffer;
  const sha256 = await sha256Of(uf2Bytes);
  const { fetchStub, calls } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(
      200,
      validManifestJson(sha256, {
        // If somehow accepted, still must not be fetched — but validator rejects.
        uf2Url: "https://evil.example/payload.uf2",
      })
    ),
    [EXPECTED_UF2_URL]: binaryResponse(200, uf2Bytes),
    "https://evil.example/payload.uf2": binaryResponse(200, uf2Bytes),
  });

  await assertReject(
    downloadAndVerifyFirmware(MANIFEST_URL, {
      fetch: fetchStub,
      crypto: webcrypto,
    }),
    "external uf2Url in manifest"
  );
  assert.ok(!calls.includes("https://evil.example/payload.uf2"));
}

{
  const uf2Bytes = new Uint8Array([4, 5, 6]).buffer;
  const sha256 = await sha256Of(uf2Bytes);
  const { fetchStub, calls } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(
      200,
      validManifestJson(sha256, { uf2Url: "../MP9_V1-0.3.1.uf2" })
    ),
    [EXPECTED_UF2_URL]: binaryResponse(200, uf2Bytes),
  });

  await assertReject(
    downloadAndVerifyFirmware(MANIFEST_URL, {
      fetch: fetchStub,
      crypto: webcrypto,
    }),
    "../ traversal uf2Url"
  );
  assert.ok(!calls.some((u) => u.includes("..")));
  assert.deepEqual(calls, [MANIFEST_URL]);
}

// --- verified sha256 is from actual bytes, not merely echoed from manifest ---
{
  const uf2Bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01]).buffer;
  const actual = await sha256Of(uf2Bytes);
  const { fetchStub } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(actual)),
    [EXPECTED_UF2_URL]: binaryResponse(200, uf2Bytes),
  });
  const result = await downloadAndVerifyFirmware(MANIFEST_URL, {
    fetch: fetchStub,
    crypto: webcrypto,
  });
  assert.equal(result.ok, true);
  const redigest = await sha256Of(result.download.uf2Bytes);
  assert.equal(result.download.sha256, redigest);
  assert.equal(result.download.sha256, result.download.manifest.sha256);
}

// --- browser-safe default fetch: must not detach Window.fetch ---
{
  const previousFetch = globalThis.fetch;
  const owner = globalThis;
  const calls = [];
  const inits = [];
  const sha256 = "d".repeat(64);

  function windowLikeFetch(url, init) {
    if (this !== owner) {
      throw new TypeError(
        "Failed to execute 'fetch' on 'Window': Illegal invocation"
      );
    }
    calls.push(String(url));
    inits.push(init);
    if (String(url) === MANIFEST_URL) {
      return jsonResponse(200, validManifestJson(sha256));
    }
    if (String(url) === EXPECTED_UF2_URL) {
      return binaryResponse(200, new Uint8Array([1, 2, 3]));
    }
    throw new Error(`unexpected fetch: ${url}`);
  }

  // Detached assignment — same shape as `const f = window.fetch`.
  globalThis.fetch = windowLikeFetch;
  try {
    const detached = globalThis.fetch;
    await assert.rejects(
      async () => detached(MANIFEST_URL),
      /Illegal invocation/,
      "detached fetch must throw (regression fixture)"
    );

    const manifestResult = await fetchFirmwareManifest(MANIFEST_URL, {
      crypto: webcrypto,
    });
    assert.equal(manifestResult.ok, true, "default fetch must use method call");
    assert.deepEqual(calls, [MANIFEST_URL]);
    assert.deepEqual(inits, [{ cache: "no-store" }]);

    // Injected fetch is used as-is (not wrapped through globalThis.fetch).
    let injectedThis;
    const injectedCalls = [];
    const injectedInits = [];
    const injected = async function injectedFetch(url, init) {
      injectedThis = this;
      injectedCalls.push(String(url));
      injectedInits.push(init);
      return jsonResponse(200, validManifestJson(sha256));
    };
    const injectedResult = await fetchFirmwareManifest(MANIFEST_URL, {
      fetch: injected,
      crypto: webcrypto,
    });
    assert.equal(injectedResult.ok, true);
    assert.notEqual(
      injectedThis,
      owner,
      "injected fetch must not be rebound to globalThis/window"
    );
    assert.deepEqual(injectedCalls, [MANIFEST_URL]);
    assert.deepEqual(injectedInits, [{ cache: "no-store" }]);
    assert.deepEqual(calls, [MANIFEST_URL], "default fetch must not run when injected");
    assert.deepEqual(inits, [{ cache: "no-store" }], "default fetch must not run when injected");
  } finally {
    globalThis.fetch = previousFetch;
  }
}

// --- browser-like: relative manifestUrl resolves against location.href ---
{
  const pageHref = "https://example.github.io/mini-cube-configurator/";
  const relativeManifestUrl = "./firmware/latest/manifest.json";
  const effectiveManifestUrl =
    "https://example.github.io/mini-cube-configurator/firmware/latest/manifest.json";
  const expectedUf2Url =
    "https://example.github.io/mini-cube-configurator/firmware/latest/MP9_V1-0.3.0.uf2";

  const uf2Bytes = new Uint8Array([0x55, 0x46, 0x32, 0x0a]).buffer;
  const sha256 = await sha256Of(uf2Bytes);
  const { fetchStub, calls, inits } = makeFetchStub({
    [effectiveManifestUrl]: jsonResponse(
      200,
      validManifestJson(sha256, {
        version: "0.3.0",
        uf2: "MP9_V1-0.3.0.uf2",
        uf2Url: "./MP9_V1-0.3.0.uf2",
      })
    ),
    [expectedUf2Url]: binaryResponse(200, uf2Bytes),
  });

  const previousLocationDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "location"
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    enumerable: true,
    value: { href: pageHref },
    writable: true,
  });

  try {
    const manifestResult = await fetchFirmwareManifest(relativeManifestUrl, {
      fetch: fetchStub,
      crypto: webcrypto,
    });
    assert.equal(manifestResult.ok, true);
    assert.equal(manifestResult.manifestUrl, effectiveManifestUrl);
    assert.deepEqual(calls, [effectiveManifestUrl]);
    assert.deepEqual(inits, [{ cache: "no-store" }]);

    const downloadResult = await downloadAndVerifyFirmware(relativeManifestUrl, {
      fetch: fetchStub,
      crypto: webcrypto,
    });
    assert.equal(downloadResult.ok, true);
    assert.equal(downloadResult.download.uf2Url, expectedUf2Url);
    assert.deepEqual(calls, [
      effectiveManifestUrl,
      effectiveManifestUrl,
      expectedUf2Url,
    ]);
    assert.deepEqual(inits, [
      { cache: "no-store" },
      { cache: "no-store" },
      undefined,
    ]);
  } finally {
    if (previousLocationDescriptor) {
      Object.defineProperty(globalThis, "location", previousLocationDescriptor);
    } else {
      delete globalThis.location;
    }
  }
}

// --- absolute manifest URL unchanged even when location is present ---
{
  const previousLocationDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "location"
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    enumerable: true,
    value: { href: "https://example.github.io/mini-cube-configurator/" },
    writable: true,
  });

  try {
    const sha256 = "e".repeat(64);
    const { fetchStub, calls, inits } = makeFetchStub({
      [MANIFEST_URL]: jsonResponse(200, validManifestJson(sha256)),
    });
    const result = await fetchFirmwareManifest(MANIFEST_URL, {
      fetch: fetchStub,
      crypto: webcrypto,
    });
    assert.equal(result.ok, true);
    assert.equal(result.manifestUrl, MANIFEST_URL);
    assert.deepEqual(calls, [MANIFEST_URL]);
    assert.deepEqual(inits, [{ cache: "no-store" }]);
  } finally {
    if (previousLocationDescriptor) {
      Object.defineProperty(globalThis, "location", previousLocationDescriptor);
    } else {
      delete globalThis.location;
    }
  }
}

// --- no location: relative manifestUrl kept as-is for injected DI ---
{
  assert.equal(globalThis.location, undefined);
  const relativeManifestUrl = "./firmware/latest/manifest.json";
  const sha256 = "f".repeat(64);
  const { fetchStub, calls, inits } = makeFetchStub({
    [relativeManifestUrl]: jsonResponse(200, validManifestJson(sha256)),
  });
  const result = await fetchFirmwareManifest(relativeManifestUrl, {
    fetch: fetchStub,
    crypto: webcrypto,
  });
  assert.equal(result.ok, true);
  assert.equal(result.manifestUrl, relativeManifestUrl);
  assert.deepEqual(calls, [relativeManifestUrl]);
  assert.deepEqual(inits, [{ cache: "no-store" }]);
}

console.log("firmware-dist tests passed");
