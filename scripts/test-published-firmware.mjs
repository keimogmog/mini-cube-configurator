import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  downloadAndVerifyFirmware,
  digestSha256Hex,
} from "../src/firmwareDist.js";
import { parseFirmwareManifest, resolveFirmwareUf2Url } from "../src/firmwareManifest.js";
import {
  buildFlashPlan,
  isKnownMp9Uf2Name,
  isKnownProgrammableUf2Name,
} from "../src/flashPlan.js";

async function assertPublishedLatest({ latestDir, expectedVersion, expectedUf2, expectedSha, expectedMinEnter }) {
  const manifestPath = path.join(latestDir, "manifest.json");
  const manifestJson = JSON.parse(await readFile(manifestPath, "utf8"));
  const parsed = parseFirmwareManifest(manifestJson);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.manifest.version, expectedVersion);
  assert.equal(parsed.manifest.uf2, expectedUf2);
  assert.equal(isKnownProgrammableUf2Name(parsed.manifest.uf2), true);
  if (parsed.manifest.device === "MP9") {
    assert.equal(isKnownMp9Uf2Name(parsed.manifest.uf2), true);
  }
  assert.equal(parsed.manifest.sha256, expectedSha);
  assert.equal(parsed.manifest.minDeviceFirmwareForEnterBootloader, expectedMinEnter);

  const uf2Path = path.join(latestDir, parsed.manifest.uf2);
  const uf2Bytes = await readFile(uf2Path);
  const buffer = uf2Bytes.buffer.slice(
    uf2Bytes.byteOffset,
    uf2Bytes.byteOffset + uf2Bytes.byteLength
  );
  const digest = await digestSha256Hex(buffer, { crypto: webcrypto });
  assert.equal(digest.ok, true);
  assert.equal(digest.sha256, parsed.manifest.sha256);

  const manifestUrl = pathToFileURL(manifestPath).href;
  const uf2Url = resolveFirmwareUf2Url(manifestUrl, parsed.manifest);
  assert.equal(uf2Url, pathToFileURL(uf2Path).href);

  const fetchStub = async (url) => {
    const key = String(url);
    if (key === manifestUrl) {
      return {
        ok: true,
        status: 200,
        async json() {
          return manifestJson;
        },
      };
    }
    if (key === uf2Url) {
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return buffer.slice(0);
        },
      };
    }
    throw new Error(`unexpected fetch: ${key}`);
  };

  const verified = await downloadAndVerifyFirmware(manifestUrl, {
    fetch: fetchStub,
    crypto: webcrypto,
  });
  assert.equal(verified.ok, true, verified.error);
  assert.equal(verified.download.sha256, parsed.manifest.sha256);

  const plan = buildFlashPlan(verified.download.uf2Bytes, {
    connected: true,
    productId: 0x0003,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.isRp2040, true);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await assertPublishedLatest({
  latestDir: path.join(root, "firmware/latest"),
  expectedVersion: "0.3.2",
  expectedUf2: "MP9_V1-0.3.2.uf2",
  expectedSha: "436ce13865c386768d099fd382a50f9fc153f0d98df26dbebd5d7b93fda20954",
  expectedMinEnter: "0.3.0",
});

await assertPublishedLatest({
  latestDir: path.join(root, "firmware/mf5/latest"),
  expectedVersion: "0.2.1",
  expectedUf2: "MF5_V1-0.2.1.uf2",
  expectedSha: "daec9fe908c1588113ad97a67cb2b5bf93163b43751096bedddcb65eec3e164e",
  expectedMinEnter: "0.1.0",
});

console.log("published-firmware artifacts tests passed");
