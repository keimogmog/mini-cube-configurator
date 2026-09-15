import assert from "node:assert/strict";
import {
  FLASH_PAGE_SIZE,
  FLASH_SECTOR_SIZE,
  KNOWN_MP9_UF2_FILENAME,
  MP9_EEPROM_XIP_START,
  XIP_BASE,
  assertEraseRangeSafe,
  assertPageWriteSafe,
  assertPlanReadyToProgram,
  buildFlashPlan,
  isKnownMp9Uf2Name,
  parseStoredConfig,
} from "../src/flashPlan.js";
import {
  RP2040_FAMILY_ID,
  RP2350_ARM_S_FAMILY_ID,
  UF2_BLOCK_SIZE,
  UF2_FLAG_FAMILY_ID_PRESENT,
  UF2_MAGIC_END,
  UF2_MAGIC_START0,
  UF2_MAGIC_START1,
} from "../src/uf2.js";

function writeBlock(targetAddr, blockNo, numBlocks, payload, extras = {}) {
  const block = new Uint8Array(UF2_BLOCK_SIZE);
  const view = new DataView(block.buffer);
  view.setUint32(0, UF2_MAGIC_START0, true);
  view.setUint32(4, UF2_MAGIC_START1, true);
  view.setUint32(8, extras.flags ?? UF2_FLAG_FAMILY_ID_PRESENT, true);
  view.setUint32(12, targetAddr, true);
  view.setUint32(16, extras.payloadSize ?? FLASH_PAGE_SIZE, true);
  view.setUint32(20, blockNo, true);
  view.setUint32(24, extras.numBlocks ?? numBlocks, true);
  view.setUint32(28, extras.familyId ?? RP2040_FAMILY_ID, true);
  block.set(payload, 32);
  view.setUint32(508, UF2_MAGIC_END, true);
  return block;
}

function makeUf2(pageCount, extras = {}) {
  const start = extras.start ?? XIP_BASE;
  const stride = extras.stride ?? FLASH_PAGE_SIZE;
  const parts = [];
  for (let i = 0; i < pageCount; i += 1) {
    const payload = new Uint8Array(FLASH_PAGE_SIZE);
    payload.fill(i & 0xff);
    parts.push(
      writeBlock(start + i * stride, extras.blockNoOffset ? extras.blockNoOffset + i : i, pageCount, payload, extras)
    );
  }
  const out = new Uint8Array(pageCount * UF2_BLOCK_SIZE);
  parts.forEach((part, i) => out.set(part, i * UF2_BLOCK_SIZE));
  return out;
}

const dense = makeUf2(10);
const densePlan = buildFlashPlan(dense);
assert.equal(densePlan.ok, true);
assert.equal(densePlan.flashModified, false);
assert.equal(densePlan.mutatingCommandsEnabled, false);
assert.equal(densePlan.isRp2040, true);
assert.equal(densePlan.blockCount, 10);
assert.equal(densePlan.payloadPageCount, 10);
assert.equal(densePlan.firstTargetAddr, XIP_BASE);
assert.equal(densePlan.lastTargetAddr, XIP_BASE + 9 * FLASH_PAGE_SIZE);
assert.equal(densePlan.writeBytes, 10 * FLASH_PAGE_SIZE);
assert.equal(densePlan.eraseStart, XIP_BASE);
assert.equal(densePlan.eraseEnd, XIP_BASE + FLASH_SECTOR_SIZE);
assert.equal(densePlan.eraseSectors, 1);
assert.equal(densePlan.payloadPages.length, 10);
assert.equal(densePlan.payloadPages[0].addr, XIP_BASE);
assert.equal(densePlan.payloadPages[0].data.length, FLASH_PAGE_SIZE);
assert.equal(densePlan.payloadPages[9].data[0], 9);

assert.equal(
  densePlan.checks.find((check) => check.id === "eeprom_overlap").status,
  "pass"
);

const rp2350 = makeUf2(2, { familyId: RP2350_ARM_S_FAMILY_ID });
const rp2350Plan = buildFlashPlan(rp2350);
assert.equal(rp2350Plan.ok, false);
assert.equal(rp2350Plan.isRp2040, false);

const gapped = makeUf2(2, { stride: FLASH_PAGE_SIZE * 2 });
const gappedPlan = buildFlashPlan(gapped);
assert.equal(gappedPlan.ok, false);
assert.equal(gappedPlan.hasGaps, true);

const eepromHit = makeUf2(1, { start: MP9_EEPROM_XIP_START });
const eepromPlan = buildFlashPlan(eepromHit);
assert.equal(eepromPlan.ok, false);
assert.equal(eepromPlan.eepromOverlap, true);

const usbFail = buildFlashPlan(dense, { connected: true, productId: 0x000f });
assert.equal(usbFail.ok, false);
assert.equal(usbFail.checks.find((check) => check.id === "usb_device").status, "fail");

const storedOk = new Uint8Array(256);
storedOk.set([0x4d, 0x50, 0x39, 0x43, 1, 1, 30, 31, 32, 33, 34, 35, 36, 37, 38, 0]);
let xor = 0;
for (let i = 0; i < 15; i += 1) {
  xor ^= storedOk[i];
}
storedOk[15] = xor;
const parsed = parseStoredConfig(storedOk);
assert.equal(parsed.ok, true);
assert.equal(parsed.magic, "MP9C");
assert.equal(parsed.midiChannel, 1);
assert.deepEqual(parsed.padCc, [30, 31, 32, 33, 34, 35, 36, 37, 38]);

const erased = new Uint8Array(256).fill(0xff);
assert.equal(parseStoredConfig(erased).ok, false);

assert.equal(isKnownMp9Uf2Name(KNOWN_MP9_UF2_FILENAME), true);
assert.equal(isKnownMp9Uf2Name("MP9_V1-1.0.0.uf2"), true);
assert.equal(isKnownMp9Uf2Name("MP9_V1-1.2.3.uf2"), true);
assert.equal(isKnownMp9Uf2Name("MP9_V1-10.20.300.uf2"), true);
assert.equal(isKnownMp9Uf2Name("MP9_V1-0.3.1.uf2"), true);

assert.equal(isKnownMp9Uf2Name("other.uf2"), false);
assert.equal(isKnownMp9Uf2Name("MP9_V1-1.2.uf2"), false);
assert.equal(isKnownMp9Uf2Name("MP9_V1-1.2.3.4.uf2"), false);
assert.equal(isKnownMp9Uf2Name("MP9_V1-v1.2.3.uf2"), false);
assert.equal(isKnownMp9Uf2Name("MP9_V1-1.2.3.exe"), false);
assert.equal(isKnownMp9Uf2Name("MP9_V1-1.2.3.uf2.exe"), false);
assert.equal(isKnownMp9Uf2Name("foo_MP9_V1-1.2.3.uf2"), false);
assert.equal(isKnownMp9Uf2Name("MP9_V1-1.2.3.uf2.bak"), false);
assert.equal(isKnownMp9Uf2Name("../MP9_V1-1.2.3.uf2"), false);
assert.equal(isKnownMp9Uf2Name("path/MP9_V1-1.2.3.uf2"), false);
assert.equal(isKnownMp9Uf2Name("MP9_V1-1.2.3%00.uf2"), false);
assert.equal(isKnownMp9Uf2Name("mp9_v1-1.2.3.uf2"), false);
assert.equal(isKnownMp9Uf2Name(""), false);
assert.equal(isKnownMp9Uf2Name(null), false);
assert.equal(isKnownMp9Uf2Name(undefined), false);
assert.equal(isKnownMp9Uf2Name(123), false);
assert.equal(isKnownMp9Uf2Name({}), false);

const readyPlan = buildFlashPlan(dense, { connected: true, productId: 0x0003 });
assertPlanReadyToProgram(readyPlan, { fileName: KNOWN_MP9_UF2_FILENAME, productId: 0x0003 });
assertPlanReadyToProgram(readyPlan, { fileName: "MP9_V1-1.2.3.uf2", productId: 0x0003 });
assert.throws(() => assertPlanReadyToProgram(readyPlan, { fileName: "other.uf2", productId: 0x0003 }));
assert.throws(() => assertPlanReadyToProgram(readyPlan, { fileName: "MP9_V1-1.2.uf2", productId: 0x0003 }));
assert.throws(() => assertPlanReadyToProgram(readyPlan, { fileName: KNOWN_MP9_UF2_FILENAME, productId: 0x000f }));
assert.throws(() =>
  assertEraseRangeSafe(readyPlan, MP9_EEPROM_XIP_START, FLASH_SECTOR_SIZE)
);
assert.throws(() => assertPageWriteSafe(readyPlan, MP9_EEPROM_XIP_START, readyPlan.payloadPages[0].data));
assert.throws(() =>
  assertEraseRangeSafe(readyPlan, readyPlan.eraseStart, readyPlan.eraseEnd - readyPlan.eraseStart + FLASH_SECTOR_SIZE)
);

console.log("flash-plan dry-run checks passed");
