import assert from "node:assert/strict";
import {
  FLASH_PAGE_SIZE,
  FLASH_SECTOR_SIZE,
  MP9_EEPROM_XIP_START,
  XIP_BASE,
  buildFlashPlan,
  isKnownMp9Uf2Name,
} from "../src/flashPlan.js";
import { assertFinalEepromGuard, programAcceptedFlashPlan } from "../src/flashProgram.js";
import {
  EXCLUSIVE_AND_EJECT,
  PC_EXCLUSIVE_ACCESS,
  PC_FLASH_ERASE,
  PC_READ,
  PC_REBOOT,
  PC_WRITE,
  REBOOT_DELAY_MS,
  assertPicobootCommandGate,
} from "../src/picoboot.js";
import {
  RP2040_FAMILY_ID,
  UF2_BLOCK_SIZE,
  UF2_FLAG_FAMILY_ID_PRESENT,
  UF2_MAGIC_END,
  UF2_MAGIC_START0,
  UF2_MAGIC_START1,
} from "../src/uf2.js";

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

function makeUf2(pageCount) {
  const parts = [];
  for (let i = 0; i < pageCount; i += 1) {
    const payload = new Uint8Array(FLASH_PAGE_SIZE);
    payload.fill(i & 0xff);
    parts.push(writeBlock(XIP_BASE + i * FLASH_PAGE_SIZE, i, pageCount, payload));
  }
  const out = new Uint8Array(pageCount * UF2_BLOCK_SIZE);
  parts.forEach((part, i) => out.set(part, i * UF2_BLOCK_SIZE));
  return out;
}

const plan = buildFlashPlan(makeUf2(10), { connected: true, productId: 0x0003 });
assert.equal(plan.ok, true);
assertFinalEepromGuard(plan);

const programGate = { kind: "program", plan };
assertPicobootCommandGate(PC_EXCLUSIVE_ACCESS, programGate, { exclusiveType: EXCLUSIVE_AND_EJECT });
assertPicobootCommandGate(PC_FLASH_ERASE, programGate, {
  addr: plan.eraseStart,
  size: plan.eraseEnd - plan.eraseStart,
});
assertPicobootCommandGate(PC_WRITE, programGate, {
  addr: plan.payloadPages[0].addr,
  size: FLASH_PAGE_SIZE,
  data: plan.payloadPages[0].data,
});
assertPicobootCommandGate(PC_READ, programGate, {
  addr: plan.payloadPages[3].addr,
  size: FLASH_PAGE_SIZE,
});
assertPicobootCommandGate(PC_READ, programGate, {
  addr: 0x101ff000,
  size: 256,
});

assert.throws(() =>
  assertPicobootCommandGate(PC_FLASH_ERASE, programGate, {
    addr: MP9_EEPROM_XIP_START,
    size: FLASH_SECTOR_SIZE,
  })
);
assert.throws(() =>
  assertPicobootCommandGate(PC_WRITE, programGate, {
    addr: XIP_BASE + 11 * FLASH_PAGE_SIZE,
    size: FLASH_PAGE_SIZE,
    data: plan.payloadPages[0].data,
  })
);
assert.throws(() => assertPicobootCommandGate(PC_REBOOT, programGate, {}));
assert.throws(() =>
  assertPicobootCommandGate(PC_FLASH_ERASE, { kind: "rom-test" }, { addr: plan.eraseStart, size: FLASH_SECTOR_SIZE })
);
assert.throws(() =>
  assertPicobootCommandGate(
    PC_REBOOT,
    { kind: "reboot", ticket: { verified: false, rebootAllowed: false } },
    { reboot: { pc: 0, sp: 0, delayMs: REBOOT_DELAY_MS } }
  )
);
assertPicobootCommandGate(
  PC_REBOOT,
  { kind: "reboot", ticket: { verified: true, rebootAllowed: true } },
  { reboot: { pc: 0, sp: 0, delayMs: REBOOT_DELAY_MS } }
);
assert.throws(() =>
  assertPicobootCommandGate(
    PC_REBOOT,
    { kind: "reboot", ticket: { verified: true, rebootAllowed: true } },
    { reboot: { pc: 0x20000000, sp: 0x20040000, delayMs: REBOOT_DELAY_MS } }
  )
);

assert.equal(isKnownMp9Uf2Name("MP9_V1-1.2.3.uf2"), true);
await assert.rejects(
  () =>
    programAcceptedFlashPlan(
      { info: { productId: 0x0003 } },
      {
        plan,
        fileName: "MP9_V1-1.2.3.uf2",
        eepromBytes: new Uint8Array(16),
      }
    ),
  (err) => /EEPROM/i.test(err.message)
);
await assert.rejects(
  () =>
    programAcceptedFlashPlan(
      { info: { productId: 0x0003 } },
      {
        plan,
        fileName: "evil.uf2",
        eepromBytes: new Uint8Array(256),
      }
    ),
  (err) => /only accepts/i.test(err.message)
);

console.log("flash-program safety gates passed");
