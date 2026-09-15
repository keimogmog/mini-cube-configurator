import assert from "node:assert/strict";
import {
  FIRMWARE_MANIFEST_UF2_FAMILY,
  isMp9V1ReleaseUf2Filename,
  isSafeSameDirectoryUf2Url,
  parseFirmwareManifest,
  resolveFirmwareUf2Url,
} from "../src/firmwareManifest.js";

const VALID_SHA =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    device: "MP9",
    hardware: "V1",
    version: "0.3.1",
    uf2: "MP9_V1-0.3.1.uf2",
    uf2Url: "./MP9_V1-0.3.1.uf2",
    sha256: VALID_SHA,
    uf2Family: FIRMWARE_MANIFEST_UF2_FAMILY,
    minConfiguratorVersion: "0.0.0",
    minDeviceFirmwareForEnterBootloader: "0.3.0",
    releaseNotes: "Short user-facing notes.",
    publishedAt: "2026-09-15T00:00:00Z",
    ...overrides,
  };
}

function assertOk(input, expectedVersion) {
  const result = parseFirmwareManifest(input);
  assert.equal(result.ok, true, `expected ok for version ${expectedVersion}`);
  assert.equal(result.manifest.version, expectedVersion);
  assert.equal(result.manifest.uf2, `MP9_V1-${expectedVersion}.uf2`);
  assert.equal(result.manifest.uf2Url, `./MP9_V1-${expectedVersion}.uf2`);
  assert.equal(result.manifest.sha256, input.sha256);
  assert.equal(result.manifest.device, "MP9");
  assert.equal(result.manifest.hardware, "V1");
  assert.equal(result.manifest.uf2Family, FIRMWARE_MANIFEST_UF2_FAMILY);
}

function assertReject(input, label) {
  const result = parseFirmwareManifest(input);
  assert.equal(result.ok, false, `expected reject: ${label}`);
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0, `expected error message: ${label}`);
}

// --- VALID ---
assertOk(validManifest(), "0.3.1");
assertOk(
  validManifest({
    version: "0.9.9",
    uf2: "MP9_V1-0.9.9.uf2",
    uf2Url: "./MP9_V1-0.9.9.uf2",
  }),
  "0.9.9"
);
assertOk(
  validManifest({
    version: "0.10.0",
    uf2: "MP9_V1-0.10.0.uf2",
    uf2Url: "MP9_V1-0.10.0.uf2",
  }),
  "0.10.0"
);
assertOk(
  validManifest({
    version: "1.0.0",
    uf2: "MP9_V1-1.0.0.uf2",
    uf2Url: "./MP9_V1-1.0.0.uf2",
  }),
  "1.0.0"
);

// Bare filename uf2Url is accepted and normalized to ./filename
{
  const result = parseFirmwareManifest(
    validManifest({ uf2Url: "MP9_V1-0.3.1.uf2" })
  );
  assert.equal(result.ok, true);
  assert.equal(result.manifest.uf2Url, "./MP9_V1-0.3.1.uf2");
}

// --- REJECT: non-objects ---
assertReject(null, "null");
assertReject(undefined, "undefined");
assertReject([], "array");
assertReject("{}", "json string");
assertReject(42, "number");

// --- REJECT: missing fields ---
{
  const keys = [
    "schemaVersion",
    "device",
    "hardware",
    "version",
    "uf2",
    "uf2Url",
    "sha256",
    "uf2Family",
    "minConfiguratorVersion",
    "minDeviceFirmwareForEnterBootloader",
    "releaseNotes",
    "publishedAt",
  ];
  for (const key of keys) {
    const m = validManifest();
    delete m[key];
    assertReject(m, `missing ${key}`);
  }
}

// --- REJECT: schema / device / hardware ---
assertReject(validManifest({ schemaVersion: 2 }), "unknown schemaVersion");
assertReject(validManifest({ schemaVersion: "1" }), "schemaVersion string");
assertReject(validManifest({ device: "MF5" }), "wrong device");
assertReject(validManifest({ device: "mp9" }), "device case");
assertReject(validManifest({ hardware: "V2" }), "wrong hardware");
assertReject(validManifest({ hardware: "v1" }), "hardware case");

// --- REJECT: malformed version ---
assertReject(validManifest({ version: "v0.3.1" }), "version prefix");
assertReject(validManifest({ version: "0.3" }), "short version");
assertReject(validManifest({ version: "0.03.1" }), "leading zero version");
assertReject(validManifest({ version: "0.3.1-beta" }), "prerelease version");
assertReject(
  validManifest({
    version: "0.3.1",
    uf2: "MP9_V1-0.3.1.uf2",
    uf2Url: "./MP9_V1-0.3.1.uf2",
    minConfiguratorVersion: "01.0.0",
  }),
  "malformed minConfiguratorVersion"
);
assertReject(
  validManifest({ minDeviceFirmwareForEnterBootloader: "0.3" }),
  "malformed minDeviceFirmwareForEnterBootloader"
);

// --- REJECT: version / filename mismatch ---
assertReject(
  validManifest({
    version: "0.3.1",
    uf2: "MP9_V1-0.3.2.uf2",
    uf2Url: "./MP9_V1-0.3.2.uf2",
  }),
  "version/filename mismatch"
);

// --- REJECT: wrong filename ---
assertReject(
  validManifest({ uf2: "MP9_V1.ino.uf2", uf2Url: "./MP9_V1.ino.uf2" }),
  "arduino local output name"
);
assertReject(
  validManifest({
    version: "0.3.1",
    uf2: "MP9_V1-0.3.1.UF2",
    uf2Url: "./MP9_V1-0.3.1.UF2",
  }),
  "uppercase extension"
);
assertReject(
  validManifest({
    version: "0.3.1",
    uf2: "mp9_v1-0.3.1.uf2",
    uf2Url: "./mp9_v1-0.3.1.uf2",
  }),
  "wrong filename case"
);
assert.equal(isMp9V1ReleaseUf2Filename("MP9_V1.ino.uf2"), false);
assert.equal(isMp9V1ReleaseUf2Filename("MP9_V1-0.3.1.uf2"), true);

// --- REJECT: SHA format ---
assertReject(
  validManifest({
    sha256: "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
  }),
  "uppercase SHA"
);
assertReject(validManifest({ sha256: VALID_SHA.slice(0, 63) }), "short SHA");
assertReject(
  validManifest({ sha256: `${VALID_SHA}0` }),
  "long SHA"
);
assertReject(
  validManifest({
    sha256: "g123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  }),
  "non-hex SHA"
);

// --- REJECT: uf2Family ---
assertReject(validManifest({ uf2Family: "0xe48bff56" }), "uf2Family case");
assertReject(validManifest({ uf2Family: "0xE48BFF57" }), "wrong uf2Family");
assertReject(validManifest({ uf2Family: 0xe48bff56 }), "numeric uf2Family");

// --- REJECT: publishedAt ---
assertReject(validManifest({ publishedAt: "2026-09-15" }), "date only");
assertReject(validManifest({ publishedAt: "not-a-date" }), "malformed publishedAt");
assertReject(
  validManifest({ publishedAt: "2026-02-30T00:00:00Z" }),
  "impossible date"
);
assertReject(
  validManifest({ publishedAt: "2026-09-15T24:00:00Z" }),
  "bad hour"
);

// Offset form still accepted when valid
{
  const result = parseFirmwareManifest(
    validManifest({ publishedAt: "2026-09-15T09:00:00+09:00" })
  );
  assert.equal(result.ok, true);
}

// --- REJECT: releaseNotes type ---
assertReject(validManifest({ releaseNotes: null }), "releaseNotes null");
assertReject(validManifest({ releaseNotes: 1 }), "releaseNotes number");

// --- REJECT: unsafe URL / path ---
const unsafeUrls = [
  ["http://evil.example/x.uf2", "http"],
  ["https://evil.example/x.uf2", "https"],
  ["//evil.example/x.uf2", "protocol-relative"],
  ["javascript:alert(1)", "javascript"],
  ["data:text/plain,hi", "data"],
  ["blob:https://example/uuid", "blob"],
  ["/MP9_V1-0.3.1.uf2", "absolute path"],
  ["../MP9_V1-0.3.1.uf2", "../ traversal"],
  ["./../MP9_V1-0.3.1.uf2", "./../ traversal"],
  ["firmware/MP9_V1-0.3.1.uf2", "nested relative"],
  ["./other-0.3.1.uf2", "different filename"],
  ["./MP9_V1-0.3.1.uf2?x=1", "query"],
  ["./MP9_V1-0.3.1.uf2#x", "hash"],
  ["./MP9_V1-0.3.1.uf2%00", "percent encoding"],
  ["\\\\evil\\share\\x.uf2", "backslash"],
];

for (const [uf2Url, label] of unsafeUrls) {
  assertReject(validManifest({ uf2Url }), `unsafe URL: ${label}`);
  assert.equal(
    isSafeSameDirectoryUf2Url(uf2Url, "MP9_V1-0.3.1.uf2"),
    false,
    `isSafeSameDirectoryUf2Url: ${label}`
  );
}

assert.equal(
  isSafeSameDirectoryUf2Url("./MP9_V1-0.3.1.uf2", "MP9_V1-0.3.1.uf2"),
  true
);
assert.equal(
  isSafeSameDirectoryUf2Url("MP9_V1-0.3.1.uf2", "MP9_V1-0.3.1.uf2"),
  true
);

// resolveFirmwareUf2Url joins against manifest base only
{
  const parsed = parseFirmwareManifest(validManifest());
  assert.equal(parsed.ok, true);
  const href = resolveFirmwareUf2Url(
    "https://example.github.io/app/firmware/latest/manifest.json",
    parsed.manifest
  );
  assert.equal(
    href,
    "https://example.github.io/app/firmware/latest/MP9_V1-0.3.1.uf2"
  );
}

console.log("firmware-manifest tests passed");
