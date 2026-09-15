import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  prepareFirmwareUpdate,
  performFirmwareUpdate,
} from "../src/firmwareUpdate.js";
import { FIRMWARE_MANIFEST_UF2_FAMILY } from "../src/firmwareManifest.js";
import {
  FLASH_PAGE_SIZE,
  XIP_BASE,
  assertPlanReadyToProgram,
  buildFlashPlan,
} from "../src/flashPlan.js";
import { programAcceptedFlashPlan } from "../src/flashProgram.js";
import {
  RP2040_FAMILY_ID,
  UF2_BLOCK_SIZE,
  UF2_FLAG_FAMILY_ID_PRESENT,
  UF2_MAGIC_END,
  UF2_MAGIC_START0,
  UF2_MAGIC_START1,
} from "../src/uf2.js";

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

function writeBlock(targetAddr, blockNo, numBlocks, payload) {
  const block = new Uint8Array(UF2_BLOCK_SIZE);
  const view = new DataView(block.buffer);
  view.setUint32(0, UF2_MAGIC_START0, true);
  view.setUint32(4, UF2_MAGIC_START1, true);
  view.setUint32(8, UF2_FLAG_FAMILY_ID_PRESENT, true);
  view.setUint32(12, targetAddr, true);
  view.setUint32(16, FLASH_PAGE_SIZE, true);
  view.setUint32(20, blockNo, true);
  view.setUint32(24, numBlocks, true);
  view.setUint32(28, RP2040_FAMILY_ID, true);
  block.set(payload, 32);
  view.setUint32(508, UF2_MAGIC_END, true);
  return block;
}

function makeAcceptUf2(pageCount = 4) {
  const parts = [];
  for (let i = 0; i < pageCount; i += 1) {
    const payload = new Uint8Array(FLASH_PAGE_SIZE);
    payload.fill((i * 17 + 3) & 0xff);
    parts.push(writeBlock(XIP_BASE + i * FLASH_PAGE_SIZE, i, pageCount, payload));
  }
  const out = new Uint8Array(pageCount * UF2_BLOCK_SIZE);
  parts.forEach((part, i) => out.set(part, i * UF2_BLOCK_SIZE));
  return out.buffer;
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
  const fetchStub = async (url) => {
    const key = String(url);
    calls.push(key);
    if (typeof routes[key] === "function") {
      return routes[key]();
    }
    if (routes[key]) {
      return routes[key];
    }
    throw new Error(`unexpected fetch: ${key}`);
  };
  return { fetchStub, calls };
}

async function assertReject(promise, label) {
  const result = await promise;
  assert.equal(result.ok, false, `expected reject: ${label}`);
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0, `expected error: ${label}`);
  return result;
}

const acceptUf2 = makeAcceptUf2(4);
const acceptSha = await sha256Of(acceptUf2);
const acceptPlan = buildFlashPlan(acceptUf2, { connected: true, productId: 0x0003 });
assert.equal(acceptPlan.ok, true, "fixture UF2 must ACCEPT");

// --- 1. verified UF2 is passed into existing flash plan ---
{
  let planInput = null;
  let planCalls = 0;
  const { fetchStub } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(acceptSha)),
    [EXPECTED_UF2_URL]: binaryResponse(200, acceptUf2),
  });

  const result = await prepareFirmwareUpdate(MANIFEST_URL, {
    fetch: fetchStub,
    crypto: webcrypto,
    connected: true,
    productId: 0x0003,
    buildFlashPlan(input, opts) {
      planCalls += 1;
      planInput = input;
      return buildFlashPlan(input, opts);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(planCalls, 1);
  assert.equal(planInput, result.prepared.download.uf2Bytes);
  assert.equal(result.prepared.download.sha256, acceptSha);
  assert.equal(result.prepared.fileName, "MP9_V1-0.3.1.uf2");
  assert.equal(result.prepared.plan.ok, true);
  assert.equal(result.prepared.plan.payloadPageCount, acceptPlan.payloadPageCount);
  assert.equal(result.prepared.plan.firstTargetAddr, XIP_BASE);
  assert.deepEqual(
    [...result.prepared.plan.payloadPages[0].data],
    [...acceptPlan.payloadPages[0].data]
  );
}

// --- 2. SHA mismatch → flash plan / program never called ---
{
  let planCalls = 0;
  let programCalls = 0;
  const wrongSha = "c".repeat(64);
  const { fetchStub } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(wrongSha)),
    [EXPECTED_UF2_URL]: binaryResponse(200, acceptUf2),
  });

  const prepared = await assertReject(
    prepareFirmwareUpdate(MANIFEST_URL, {
      fetch: fetchStub,
      crypto: webcrypto,
      buildFlashPlan(...args) {
        planCalls += 1;
        return buildFlashPlan(...args);
      },
    }),
    "SHA mismatch prepare"
  );
  assert.match(prepared.error, /SHA-256/i);
  assert.equal(planCalls, 0);

  const performed = await assertReject(
    performFirmwareUpdate(
      MANIFEST_URL,
      { info: { productId: 0x0003 } },
      {
        fetch: fetchStub,
        crypto: webcrypto,
        eepromBytes: new Uint8Array(256),
        buildFlashPlan(...args) {
          planCalls += 1;
          return buildFlashPlan(...args);
        },
        async programAcceptedFlashPlan() {
          programCalls += 1;
          return { ticket: { verified: true } };
        },
      }
    ),
    "SHA mismatch perform"
  );
  assert.match(performed.error, /SHA-256/i);
  assert.equal(planCalls, 0);
  assert.equal(programCalls, 0);
}

// --- 3. manifest fetch failure → no flash ---
{
  let planCalls = 0;
  let programCalls = 0;
  const { fetchStub, calls } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(404, { error: "missing" }),
  });

  const result = await assertReject(
    performFirmwareUpdate(
      MANIFEST_URL,
      { info: { productId: 0x0003 } },
      {
        fetch: fetchStub,
        crypto: webcrypto,
        eepromBytes: new Uint8Array(256),
        buildFlashPlan(...args) {
          planCalls += 1;
          return buildFlashPlan(...args);
        },
        async programAcceptedFlashPlan() {
          programCalls += 1;
          return {};
        },
      }
    ),
    "manifest HTTP 404"
  );
  assert.match(result.error, /manifest fetch/i);
  assert.deepEqual(calls, [MANIFEST_URL]);
  assert.equal(planCalls, 0);
  assert.equal(programCalls, 0);
}

// --- 4. UF2 fetch failure → no flash ---
{
  let planCalls = 0;
  let programCalls = 0;
  const { fetchStub, calls } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(acceptSha)),
    [EXPECTED_UF2_URL]: binaryResponse(500, new Uint8Array([1])),
  });

  const result = await assertReject(
    performFirmwareUpdate(
      MANIFEST_URL,
      { info: { productId: 0x0003 } },
      {
        fetch: fetchStub,
        crypto: webcrypto,
        eepromBytes: new Uint8Array(256),
        buildFlashPlan(...args) {
          planCalls += 1;
          return buildFlashPlan(...args);
        },
        async programAcceptedFlashPlan() {
          programCalls += 1;
          return {};
        },
      }
    ),
    "UF2 HTTP 500"
  );
  assert.match(result.error, /UF2 fetch/i);
  assert.deepEqual(calls, [MANIFEST_URL, EXPECTED_UF2_URL]);
  assert.equal(planCalls, 0);
  assert.equal(programCalls, 0);
}

// --- 5. plan failure → program not called ---
{
  let programCalls = 0;
  const { fetchStub } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(acceptSha)),
    [EXPECTED_UF2_URL]: binaryResponse(200, acceptUf2),
  });

  const result = await assertReject(
    performFirmwareUpdate(
      MANIFEST_URL,
      { info: { productId: 0x0003 } },
      {
        fetch: fetchStub,
        crypto: webcrypto,
        eepromBytes: new Uint8Array(256),
        buildFlashPlan() {
          return { ok: false, payloadPageCount: 0, checks: [] };
        },
        async programAcceptedFlashPlan() {
          programCalls += 1;
          return {};
        },
      }
    ),
    "plan REJECT"
  );
  assert.match(result.error, /flash plan rejected/i);
  assert.equal(programCalls, 0);
  assert.equal(result.plan.ok, false);
  assert.ok(result.download);
}

// --- 6. successful flow: existing flash program receives correct data ---
{
  let acceptedArg = null;
  let sessionArg = null;
  let programOptions = null;
  const eepromBytes = new Uint8Array(256);
  eepromBytes[0] = 0x4d;
  const session = { info: { productId: 0x0003 } };
  const { fetchStub } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(acceptSha)),
    [EXPECTED_UF2_URL]: binaryResponse(200, acceptUf2),
  });

  const result = await performFirmwareUpdate(MANIFEST_URL, session, {
    fetch: fetchStub,
    crypto: webcrypto,
    eepromBytes,
    onProgress() {},
    async programAcceptedFlashPlan(sess, accepted, opts) {
      sessionArg = sess;
      acceptedArg = accepted;
      programOptions = opts;
      return {
        ticket: { verified: true, rebootAllowed: true },
        pageCount: accepted.plan.payloadPageCount,
        writeBytes: accepted.plan.writeBytes,
        eraseSectors: accepted.plan.eraseSectors,
        eepromUnchanged: true,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(sessionArg, session);
  assert.equal(acceptedArg.fileName, "MP9_V1-0.3.1.uf2");
  assert.equal(acceptedArg.eepromBytes, eepromBytes);
  assert.equal(acceptedArg.plan.ok, true);
  assert.equal(acceptedArg.plan.payloadPageCount, acceptPlan.payloadPageCount);
  assert.equal(acceptedArg.plan.writeBytes, acceptPlan.writeBytes);
  assert.equal(acceptedArg.plan.eraseStart, acceptPlan.eraseStart);
  assert.equal(acceptedArg.plan.eraseEnd, acceptPlan.eraseEnd);
  assert.deepEqual(
    [...acceptedArg.plan.payloadPages[2].data],
    [...acceptPlan.payloadPages[2].data]
  );
  assert.equal(acceptedArg.livePlan.ok, true);
  assert.equal(acceptedArg.livePlan.payloadPageCount, acceptedArg.plan.payloadPageCount);
  assert.equal(typeof programOptions.onProgress, "function");
  assert.equal(result.program.pageCount, acceptPlan.payloadPageCount);
  assert.equal(result.prepared.download.sha256, acceptSha);
}

// --- 7. dependency injection works (custom download hook) ---
{
  let downloadCalled = false;
  let programCalls = 0;
  const fakeDownload = Object.freeze({
    manifest: Object.freeze({
      uf2: "MP9_V1-0.3.1.uf2",
      version: "0.3.1",
      sha256: acceptSha,
    }),
    uf2Bytes: acceptUf2,
    sha256: acceptSha,
    uf2Url: EXPECTED_UF2_URL,
  });

  const prepared = await prepareFirmwareUpdate(MANIFEST_URL, {
    async downloadAndVerifyFirmware(url) {
      downloadCalled = true;
      assert.equal(String(url), MANIFEST_URL);
      return { ok: true, download: fakeDownload };
    },
    connected: true,
    productId: 0x0003,
  });
  assert.equal(downloadCalled, true);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.prepared.download, fakeDownload);
  assert.equal(prepared.prepared.plan.ok, true);

  const performed = await performFirmwareUpdate(
    MANIFEST_URL,
    { info: { productId: 0x0003 } },
    {
      async downloadAndVerifyFirmware() {
        return { ok: true, download: fakeDownload };
      },
      eepromBytes: new Uint8Array(256),
      async programAcceptedFlashPlan(_session, accepted) {
        programCalls += 1;
        assert.equal(accepted.plan.ok, true);
        return { ticket: { verified: true } };
      },
    }
  );
  assert.equal(performed.ok, true);
  assert.equal(programCalls, 1);
}

// --- missing eepromBytes → program not called ---
{
  let programCalls = 0;
  const { fetchStub } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(200, validManifestJson(acceptSha)),
    [EXPECTED_UF2_URL]: binaryResponse(200, acceptUf2),
  });

  const result = await assertReject(
    performFirmwareUpdate(
      MANIFEST_URL,
      { info: { productId: 0x0003 } },
      {
        fetch: fetchStub,
        crypto: webcrypto,
        async programAcceptedFlashPlan() {
          programCalls += 1;
          return {};
        },
      }
    ),
    "missing eepromBytes"
  );
  assert.match(result.error, /eepromBytes/i);
  assert.equal(programCalls, 0);
}

// --- integration regression: versioned release fileName clears filename gate ---
{
  const { fetchStub } = makeFetchStub({
    [MANIFEST_URL]: jsonResponse(
      200,
      validManifestJson(acceptSha, {
        version: "1.2.3",
        uf2: "MP9_V1-1.2.3.uf2",
        uf2Url: "./MP9_V1-1.2.3.uf2",
      })
    ),
    "https://example.github.io/app/firmware/latest/MP9_V1-1.2.3.uf2": binaryResponse(
      200,
      acceptUf2
    ),
  });

  const prepared = await prepareFirmwareUpdate(MANIFEST_URL, {
    fetch: fetchStub,
    crypto: webcrypto,
    connected: true,
    productId: 0x0003,
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.prepared.fileName, "MP9_V1-1.2.3.uf2");
  assertPlanReadyToProgram(prepared.prepared.plan, {
    fileName: prepared.prepared.fileName,
    productId: 0x0003,
  });

  await assert.rejects(
    () =>
      programAcceptedFlashPlan(
        { info: { productId: 0x0003 } },
        {
          plan: prepared.prepared.plan,
          fileName: prepared.prepared.fileName,
          eepromBytes: new Uint8Array(16),
        }
      ),
    (err) => {
      assert.match(String(err.message), /EEPROM/i);
      assert.doesNotMatch(String(err.message), /only accepts/i);
      return true;
    }
  );

  await assert.rejects(
    () =>
      programAcceptedFlashPlan(
        { info: { productId: 0x0003 } },
        {
          plan: prepared.prepared.plan,
          fileName: "other.uf2",
          eepromBytes: new Uint8Array(256),
        }
      ),
    (err) => {
      assert.match(String(err.message), /only accepts/i);
      return true;
    }
  );
}

console.log("firmware-update tests passed");
