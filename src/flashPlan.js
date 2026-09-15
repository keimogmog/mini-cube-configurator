/**
 * Immutable UF2 flash plan for MP9 / RP2040-Zero.
 *
 * Dry run computes erase/write ranges and validations. Mutating PICOBOOT
 * commands are built only from an ACCEPT plan (see flashProgram.js).
 *
 * Constants: pico-sdk hardware/flash.h, addressmap.h (XIP_BASE),
 * Arduino-Pico RP2040-Zero EEPROM at flash end − 4096.
 */

import { isMp9V1ReleaseUf2Filename } from "./firmwareManifest.js";
import {
  FAMILY_NAMES,
  RP2040_FAMILY_ID,
  familyName,
  formatUf2Addr,
  parseUf2,
} from "./uf2.js";


export const FLASH_PAGE_SIZE = 256;
export const FLASH_SECTOR_SIZE = 4096;
export const XIP_BASE = 0x10000000;
export const RP2040_ZERO_FLASH_SIZE = 2 * 1024 * 1024;
export const FLASH_END = XIP_BASE + RP2040_ZERO_FLASH_SIZE;
export const MP9_EEPROM_XIP_START = 0x101ff000;
export const MP9_EEPROM_XIP_END = 0x10200000;
export const MP9_EEPROM_SIZE = MP9_EEPROM_XIP_END - MP9_EEPROM_XIP_START;
export const MP9_SKETCH_END = MP9_EEPROM_XIP_START;
export const CONFIG_VERSION = 1;
export const STORAGE_MAGIC = "MP9C";

export const DRY_RUN_BANNER = "Dry Run — Flash not modified";
export const FLASH_WRITE_BANNER = "Flash write PoC — accepted Dry Run plan only";
/** Arduino build output name (PoC / local file picker). Kept for compatibility. */
export const KNOWN_MP9_UF2_FILENAME = "MP9_V1.ino.uf2";

/**
 * Filename allowlist for programming. Exact string match only — no path/basename
 * normalization. Accepts the Arduino known name or a versioned release UF2
 * (`MP9_V1-<major>.<minor>.<patch>.uf2`, same rules as firmwareManifest).
 *
 * @param {unknown} fileName
 * @returns {boolean}
 */
export function isKnownMp9Uf2Name(fileName) {
  return fileName === KNOWN_MP9_UF2_FILENAME || isMp9V1ReleaseUf2Filename(fileName);
}

export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function rangeTouchesEeprom(start, end) {
  return rangesOverlap(start, end, MP9_EEPROM_XIP_START, MP9_EEPROM_XIP_END);
}

export function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function alignDownPow2(value, size) {
  return value & ~(size - 1);
}

function alignUpPow2(value, size) {
  return (value + size - 1) & ~(size - 1);
}

function xorChecksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    sum ^= bytes[i];
  }
  return sum & 0xff;
}

export function parseStoredConfig(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length < 16) {
    return {
      ok: false,
      present: false,
      reason: `Need 16 bytes for StoredConfig, got ${data.length}.`,
    };
  }

  const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
  const version = data[4];
  const midiChannel = data[5];
  const padCc = Array.from(data.subarray(6, 15));
  const checksum = data[15];
  const expected = xorChecksum(data.subarray(0, 15));
  const magicOk = magic === STORAGE_MAGIC;
  const versionOk = version === CONFIG_VERSION;
  const checksumOk = checksum === expected;
  const channelOk = midiChannel >= 1 && midiChannel <= 16;
  const ccOk = padCc.every((value) => value >= 0 && value <= 127);
  const ok = magicOk && versionOk && checksumOk && channelOk && ccOk;

  const reasons = [];
  if (!magicOk) {
    reasons.push(`magic is ${JSON.stringify(magic)} (expected ${STORAGE_MAGIC})`);
  }
  if (!versionOk) {
    reasons.push(`version ${version} (expected ${CONFIG_VERSION})`);
  }
  if (!checksumOk) {
    reasons.push(`checksum 0x${checksum.toString(16).toUpperCase().padStart(2, "0")} ≠ XOR 0x${expected.toString(16).toUpperCase().padStart(2, "0")}`);
  }
  if (!channelOk) {
    reasons.push(`MIDI channel ${midiChannel} is out of 1–16`);
  }
  if (!ccOk) {
    reasons.push("a pad CC is outside 0–127");
  }

  return {
    ok,
    present: magicOk,
    magic,
    magicOk,
    version,
    versionOk,
    midiChannel,
    padCc,
    checksum,
    expectedChecksum: expected,
    checksumOk,
    channelOk,
    ccOk,
    reason: ok ? "Valid StoredConfig (MP9C)." : reasons.join("; ") || "Invalid StoredConfig.",
  };
}

export function formatStoredConfig(parsed, extra = {}) {
  if (!parsed) {
    return extra.note || "—";
  }
  const lines = [
    extra.note || null,
    extra.commandLine || null,
    `magic: ${parsed.magic} (${parsed.magicOk ? "MP9C OK" : "not MP9C"})`,
    `version: ${parsed.version} (${parsed.versionOk ? "OK" : "unexpected"})`,
    `MIDI channel: ${parsed.midiChannel}`,
    `Pad CC: ${parsed.padCc.join(", ")}`,
    `checksum: 0x${parsed.checksum.toString(16).toUpperCase().padStart(2, "0")} (XOR 0x${parsed.expectedChecksum.toString(16).toUpperCase().padStart(2, "0")}, ${parsed.checksumOk ? "OK" : "mismatch"})`,
    `record: ${parsed.ok ? "valid — firmware would keep Channel/CC" : "invalid — firmware would use factory CH1 / CC30–38"}`,
    parsed.ok ? null : `detail: ${parsed.reason}`,
    extra.hex ? `EEPROM[0x101FF000..+256): ${extra.hex}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

function checkResult(id, label, status, detail) {
  return { id, label, status, detail };
}

/**
 * @param {ArrayBuffer|Uint8Array|{blocks?: object[]}} input parsed UF2 or raw bytes
 * @param {{ productId?: number|null, connected?: boolean }} options
 */
export function buildFlashPlan(input, options = {}) {
  const parsed = input && Array.isArray(input.blocks) ? input : parseUf2(input);
  const checks = [];
  const notes = [];

  const geometryFail = parsed.issues.filter((item) => item.code === "file_geometry");
  const magicFail = parsed.issues.filter((item) => item.code === "magic");
  checks.push(
    checkResult(
      "file_geometry",
      "File geometry (N × 512, N = num_blocks)",
      geometryFail.length ? "fail" : parsed.sliceCount >= 1 ? "pass" : "fail",
      geometryFail.length
        ? geometryFail.map((item) => item.message).join(" ")
        : `${parsed.fileBytes} bytes, ${parsed.sliceCount} blocks, num_blocks=${parsed.declaredBlockCount}.`
    )
  );
  checks.push(
    checkResult(
      "magic",
      "UF2 magics START0 / START1 / END",
      magicFail.length ? "fail" : parsed.blocks.length ? "pass" : "fail",
      magicFail.length ? magicFail.map((item) => item.message).join(" ") : "All blocks have UF2 magics."
    )
  );

  const blocks = parsed.blocks || [];
  const missingFamily = blocks.filter((block) => !block.familyPresent);
  checks.push(
    checkResult(
      "family_flag",
      "FAMILY_ID_PRESENT on every block",
      missingFamily.length ? "fail" : blocks.length ? "pass" : "fail",
      missingFamily.length ? `${missingFamily.length} block(s) omit family ID.` : "Flag 0x00002000 is set."
    )
  );

  const notMain = blocks.filter((block) => block.notMainFlash);
  checks.push(
    checkResult(
      "main_flash",
      "Main flash only (NOT_MAIN_FLASH clear)",
      notMain.length ? "fail" : blocks.length ? "pass" : "fail",
      notMain.length ? `${notMain.length} block(s) have NOT_MAIN_FLASH.` : "No NOT_MAIN_FLASH blocks."
    )
  );

  const containers = blocks.filter((block) => block.fileContainer);
  checks.push(
    checkResult(
      "file_container",
      "Not a file container",
      containers.length ? "fail" : blocks.length ? "pass" : "fail",
      containers.length ? `${containers.length} FILE_CONTAINER block(s).` : "FILE_CONTAINER flag is clear."
    )
  );

  const familyIds = [...new Set(blocks.map((block) => block.familyId).filter((id) => id !== null))];
  const familyId = familyIds.length === 1 ? familyIds[0] : null;
  const isRp2040 = familyId === RP2040_FAMILY_ID;
  let familyDetail;
  if (!familyIds.length) {
    familyDetail = "No family ID present.";
  } else if (familyIds.length > 1) {
    familyDetail = `Mixed family IDs: ${familyIds.map((id) => `${formatUf2Addr(id)} (${familyName(id)})`).join(", ")}.`;
  } else {
    familyDetail = `${formatUf2Addr(familyId)} (${familyName(familyId)}). ${isRp2040 ? "RP2040 OK." : "Not RP2040 — reject."}`;
  }
  checks.push(
    checkResult(
      "family_id",
      `Family ID is RP2040 (${formatUf2Addr(RP2040_FAMILY_ID)})`,
      isRp2040 ? "pass" : "fail",
      familyDetail
    )
  );

  const productId = options.productId;
  const connected = Boolean(options.connected) || productId === 0x0003 || productId === 0x000f;
  if (!connected) {
    checks.push(
      checkResult(
        "usb_device",
        "USB device is RP2040 boot (VID 0x2E8A / PID 0x0003)",
        "skip",
        "Bootloader not connected. This check runs when Connect to Bootloader has claimed PICOBOOT."
      )
    );
  } else if (productId === 0x0003) {
    checks.push(
      checkResult("usb_device", "USB device is RP2040 boot (VID 0x2E8A / PID 0x0003)", "pass", "Claimed device PID 0x0003 (RP2040).")
    );
  } else if (productId === 0x000f) {
    checks.push(
      checkResult(
        "usb_device",
        "USB device is RP2040 boot (VID 0x2E8A / PID 0x0003)",
        "fail",
        "Claimed device is RP2350 boot (PID 0x000F). Dry run will not program it."
      )
    );
  } else {
    checks.push(
      checkResult(
        "usb_device",
        "USB device is RP2040 boot (VID 0x2E8A / PID 0x0003)",
        "fail",
        `Unexpected boot PID 0x${Number(productId).toString(16).toUpperCase().padStart(4, "0")}.`
      )
    );
  }

  const payloadBlocks = blocks.filter(
    (block) => block.magicOk && !block.notMainFlash && !block.fileContainer && block.familyPresent
  );

  const badPayload = payloadBlocks.filter((block) => block.payloadSize !== FLASH_PAGE_SIZE);
  checks.push(
    checkResult(
      "payload_size",
      `payload_size = ${FLASH_PAGE_SIZE}`,
      payloadBlocks.length === 0 ? "fail" : badPayload.length ? "fail" : "pass",
      payloadBlocks.length === 0
        ? "No usable payload blocks."
        : badPayload.length
          ? `${badPayload.length} block(s) have payload_size ≠ ${FLASH_PAGE_SIZE}.`
          : `All ${payloadBlocks.length} payload page(s) are ${FLASH_PAGE_SIZE} bytes.`
    )
  );

  const unaligned = payloadBlocks.filter((block) => (block.targetAddr & (FLASH_PAGE_SIZE - 1)) !== 0);
  checks.push(
    checkResult(
      "alignment",
      "Target addresses are 256-byte aligned",
      payloadBlocks.length === 0 ? "fail" : unaligned.length ? "fail" : "pass",
      unaligned.length
        ? `Unaligned: ${unaligned.slice(0, 4).map((block) => formatUf2Addr(block.targetAddr)).join(", ")}.`
        : "All payload target addresses are page-aligned."
    )
  );

  const outOfWindow = payloadBlocks.filter(
    (block) => block.targetAddr < XIP_BASE || block.targetAddr + block.payloadSize > MP9_SKETCH_END
  );
  const ramOrRom = payloadBlocks.filter(
    (block) => block.targetAddr < XIP_BASE || block.targetAddr >= FLASH_END
  );
  checks.push(
    checkResult(
      "address_window",
      `XIP in [${formatUf2Addr(XIP_BASE)}, ${formatUf2Addr(MP9_SKETCH_END)})`,
      payloadBlocks.length === 0 ? "fail" : outOfWindow.length ? "fail" : "pass",
      outOfWindow.length
        ? `${outOfWindow.length} page(s) outside the MP9 sketch window (RAM/ROM/EEPROM or past flash).`
        : ramOrRom.length
          ? "Pages are inside flash."
          : "All pages are in the allowed sketch XIP window."
    )
  );

  const addrs = payloadBlocks.map((block) => block.targetAddr).sort((a, b) => a - b);
  const firstAddr = addrs.length ? addrs[0] : null;
  const lastAddr = addrs.length ? addrs[addrs.length - 1] : null;
  const lastEnd = lastAddr === null ? null : lastAddr + FLASH_PAGE_SIZE;
  checks.push(
    checkResult(
      "first_page",
      `First page at ${formatUf2Addr(XIP_BASE)} (boot2)`,
      firstAddr === XIP_BASE ? "pass" : "fail",
      firstAddr === null ? "No payload pages." : `First target_addr = ${formatUf2Addr(firstAddr)}.`
    )
  );

  const writeStart = firstAddr;
  const writeEnd = lastEnd;
  const eepromOverlap =
    writeStart !== null && rangesOverlap(writeStart, writeEnd, MP9_EEPROM_XIP_START, MP9_EEPROM_XIP_END);
  let eraseStart = null;
  let eraseEnd = null;
  let eraseSectors = 0;
  if (writeStart !== null && writeEnd !== null) {
    eraseStart = alignDownPow2(writeStart, FLASH_SECTOR_SIZE);
    eraseEnd = alignUpPow2(writeEnd, FLASH_SECTOR_SIZE);
    eraseSectors = (eraseEnd - eraseStart) / FLASH_SECTOR_SIZE;
  }
  const eraseOverlapsEeprom =
    eraseStart !== null && rangesOverlap(eraseStart, eraseEnd, MP9_EEPROM_XIP_START, MP9_EEPROM_XIP_END);

  checks.push(
    checkResult(
      "eeprom_overlap",
      `EEPROM ${formatUf2Addr(MP9_EEPROM_XIP_START)}–${formatUf2Addr(MP9_EEPROM_XIP_END - 1)} not touched`,
      eepromOverlap || eraseOverlapsEeprom ? "fail" : writeStart === null ? "fail" : "pass",
      eepromOverlap || eraseOverlapsEeprom
        ? "UF2 write or planned erase overlaps the Arduino-Pico EEPROM sector. Rejected."
        : "No overlap with EEPROM. Channel/CC sector would be preserved."
    )
  );

  const blockNos = blocks.map((block) => block.blockNo);
  const expectedNos = blocks.map((_, index) => index);
  const noSet = new Set(blockNos);
  const missingNos = expectedNos.filter((n) => !noSet.has(n));
  const outOfRangeNos = blockNos.filter((n) => n < 0 || n >= blocks.length);
  const dupNos = blockNos.filter((n, i) => blockNos.indexOf(n) !== i);
  const uniqueDupNos = [...new Set(dupNos)];
  const blockNoOk = missingNos.length === 0 && uniqueDupNos.length === 0 && outOfRangeNos.length === 0 && blocks.length > 0;
  checks.push(
    checkResult(
      "block_no",
      "block_no is exactly 0 … N−1 once each",
      blockNoOk ? "pass" : "fail",
      blockNoOk
        ? `block_no covers 0…${blocks.length - 1}.`
        : [
            uniqueDupNos.length ? `duplicate block_no: ${uniqueDupNos.slice(0, 8).join(", ")}` : null,
            missingNos.length ? `missing block_no: ${missingNos.slice(0, 8).join(", ")}` : null,
            outOfRangeNos.length ? `out-of-range block_no present` : null,
          ]
            .filter(Boolean)
            .join("; ") || "block_no set is incomplete."
    )
  );

  const addrCounts = new Map();
  for (const addr of addrs) {
    addrCounts.set(addr, (addrCounts.get(addr) || 0) + 1);
  }
  const duplicateAddrs = [...addrCounts.entries()].filter(([, count]) => count > 1).map(([addr]) => addr);
  checks.push(
    checkResult(
      "duplicates",
      "No duplicate target pages",
      duplicateAddrs.length ? "fail" : payloadBlocks.length ? "pass" : "fail",
      duplicateAddrs.length
        ? `Duplicate target_addr: ${duplicateAddrs.slice(0, 4).map(formatUf2Addr).join(", ")}.`
        : "Each payload page address appears once."
    )
  );

  const uniqueAddrs = [...addrCounts.keys()].sort((a, b) => a - b);
  const gapStarts = [];
  for (let i = 1; i < uniqueAddrs.length; i += 1) {
    if (uniqueAddrs[i] !== uniqueAddrs[i - 1] + FLASH_PAGE_SIZE) {
      gapStarts.push(uniqueAddrs[i - 1] + FLASH_PAGE_SIZE);
    }
  }
  const expectedPageCount =
    firstAddr === null || lastAddr === null ? 0 : (lastAddr - firstAddr) / FLASH_PAGE_SIZE + 1;
  const dense = gapStarts.length === 0 && uniqueAddrs.length === expectedPageCount && duplicateAddrs.length === 0;
  checks.push(
    checkResult(
      "gaps",
      "Dense page run (no holes)",
      payloadBlocks.length === 0 ? "fail" : dense ? "pass" : "fail",
      dense
        ? "Payload pages form a single contiguous run."
        : gapStarts.length
          ? `Gaps before ${gapStarts.slice(0, 4).map(formatUf2Addr).join(", ")}.`
          : "Page run is not dense."
    )
  );

  const extraIssues = parsed.issues.filter((item) => item.code === "payload");
  if (extraIssues.length) {
    notes.push(...extraIssues.map((item) => item.message));
  }

  const payloadPages = payloadBlocks
    .map((block) => ({
      addr: block.targetAddr >>> 0,
      data: Uint8Array.from(block.payload.subarray(0, FLASH_PAGE_SIZE)),
    }))
    .sort((a, b) => a.addr - b.addr);

  const failed = checks.filter((check) => check.status === "fail");
  const ok = failed.length === 0 && blocks.length > 0;

  const writeBytes = payloadBlocks.length * FLASH_PAGE_SIZE;
  const familyLabel = familyId === null && familyIds.length > 1
    ? familyIds.map((id) => `${formatUf2Addr(id)} (${familyName(id)})`).join(", ")
    : familyId === null
      ? "(none)"
      : `${formatUf2Addr(familyId)} (${familyName(familyId)})`;

  return {
    ok,
    dryRun: true,
    banner: DRY_RUN_BANNER,
    flashModified: false,
    mutatingCommandsEnabled: false,
    fileBytes: parsed.fileBytes,
    blockCount: parsed.sliceCount || blocks.length,
    declaredBlockCount: parsed.declaredBlockCount,
    payloadPageCount: payloadBlocks.length,
    writeBytes,
    familyId,
    familyIds,
    familyLabel,
    isRp2040,
    firstTargetAddr: firstAddr,
    lastTargetAddr: lastAddr,
    lastTargetEnd: lastEnd,
    eraseStart,
    eraseEnd,
    eraseSectors,
    eraseRangeText:
      eraseStart === null
        ? "—"
        : `${formatUf2Addr(eraseStart)}–${formatUf2Addr(eraseEnd - 1)} (${eraseSectors} × 4 KiB)`,
    writeRangeText:
      writeStart === null ? "—" : `${formatUf2Addr(writeStart)}–${formatUf2Addr(writeEnd - 1)} (${writeBytes} bytes)`,
    eepromRangeText: `${formatUf2Addr(MP9_EEPROM_XIP_START)}–${formatUf2Addr(MP9_EEPROM_XIP_END - 1)}`,
    eepromOverlap: Boolean(eepromOverlap || eraseOverlapsEeprom),
    hasGaps: !dense,
    hasDuplicates: duplicateAddrs.length > 0,
    missingBlockNos: missingNos,
    duplicateBlockNos: uniqueDupNos,
    checks,
    notes,
    pages: uniqueAddrs,
    payloadPages,
  };
}

export function planProgramIdentity(plan) {
  if (!plan) {
    return null;
  }
  return {
    ok: Boolean(plan.ok),
    familyId: plan.familyId,
    isRp2040: Boolean(plan.isRp2040),
    payloadPageCount: plan.payloadPageCount,
    writeBytes: plan.writeBytes,
    firstTargetAddr: plan.firstTargetAddr,
    lastTargetEnd: plan.lastTargetEnd,
    eraseStart: plan.eraseStart,
    eraseEnd: plan.eraseEnd,
    eraseSectors: plan.eraseSectors,
    eepromOverlap: Boolean(plan.eepromOverlap),
  };
}

export function plansEquivalentForProgram(a, b) {
  const idA = planProgramIdentity(a);
  const idB = planProgramIdentity(b);
  if (!idA || !idB) {
    return false;
  }
  if (JSON.stringify(idA) !== JSON.stringify(idB)) {
    return false;
  }
  const pagesA = a.payloadPages || [];
  const pagesB = b.payloadPages || [];
  if (pagesA.length !== pagesB.length) {
    return false;
  }
  for (let i = 0; i < pagesA.length; i += 1) {
    if (pagesA[i].addr !== pagesB[i].addr || !bytesEqual(pagesA[i].data, pagesB[i].data)) {
      return false;
    }
  }
  return true;
}

export function assertRangeAvoidsEeprom(start, end, label) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
    throw new Error(`${label}: invalid range ${formatUf2Addr(start)}–${formatUf2Addr(end)}.`);
  }
  if (rangeTouchesEeprom(start, end)) {
    throw new Error(
      `${label}: range ${formatUf2Addr(start)}–${formatUf2Addr(end)} overlaps EEPROM ${formatUf2Addr(MP9_EEPROM_XIP_START)}–${formatUf2Addr(MP9_EEPROM_XIP_END)}.`
    );
  }
}

export function assertEraseRangeSafe(plan, addr, size) {
  if (!plan?.ok) {
    throw new Error("Erase refused: flash plan is not ACCEPT.");
  }
  const start = addr >>> 0;
  const end = (addr + size) >>> 0;
  if (start !== plan.eraseStart || end !== plan.eraseEnd) {
    throw new Error(
      `Erase refused: ${formatUf2Addr(start)}+${size} is not the accepted erase range ${formatUf2Addr(plan.eraseStart)}–${formatUf2Addr(plan.eraseEnd)}.`
    );
  }
  if (size !== plan.eraseSectors * FLASH_SECTOR_SIZE) {
    throw new Error(
      `Erase refused: size ${size} does not match ${plan.eraseSectors} × ${FLASH_SECTOR_SIZE}.`
    );
  }
  if (start < XIP_BASE || end > MP9_SKETCH_END) {
    throw new Error("Erase refused: range is outside the MP9 sketch window.");
  }
  assertRangeAvoidsEeprom(start, end, "Erase");
}

export function assertPageWriteSafe(plan, addr, data) {
  if (!plan?.ok) {
    throw new Error("Write refused: flash plan is not ACCEPT.");
  }
  const start = addr >>> 0;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
  if (bytes.length !== FLASH_PAGE_SIZE) {
    throw new Error(`Write refused: page must be ${FLASH_PAGE_SIZE} bytes, got ${bytes.length}.`);
  }
  if ((start & (FLASH_PAGE_SIZE - 1)) !== 0) {
    throw new Error(`Write refused: address ${formatUf2Addr(start)} is not 256-byte aligned.`);
  }
  const page = (plan.payloadPages || []).find((item) => item.addr === start);
  if (!page) {
    throw new Error(`Write refused: ${formatUf2Addr(start)} is not in the accepted page list.`);
  }
  if (!bytesEqual(page.data, bytes)) {
    throw new Error(`Write refused: payload at ${formatUf2Addr(start)} does not match the accepted UF2 page.`);
  }
  assertRangeAvoidsEeprom(start, start + FLASH_PAGE_SIZE, "Write");
}

export function assertPageReadSafe(plan, addr, size) {
  if (!plan?.ok) {
    throw new Error("Verify read refused: flash plan is not ACCEPT.");
  }
  const start = addr >>> 0;
  if (size !== FLASH_PAGE_SIZE) {
    throw new Error(`Verify read refused: size must be ${FLASH_PAGE_SIZE}, got ${size}.`);
  }
  const page = (plan.payloadPages || []).find((item) => item.addr === start);
  if (!page) {
    throw new Error(`Verify read refused: ${formatUf2Addr(start)} is not in the accepted page list.`);
  }
  assertRangeAvoidsEeprom(start, start + size, "Verify read");
}

export function assertPlanReadyToProgram(plan, { fileName, productId } = {}) {
  if (!isKnownMp9Uf2Name(fileName)) {
    throw new Error(
      `This PoC only programs ${KNOWN_MP9_UF2_FILENAME} or MP9_V1-<major>.<minor>.<patch>.uf2. Selected file is ${JSON.stringify(fileName || "")}.`
    );
  }
  if (!plan?.ok) {
    throw new Error("Flash plan is not ACCEPT. Run Analyze UF2 (Dry Run) until every check passes.");
  }
  if (!plan.isRp2040 || plan.familyId !== RP2040_FAMILY_ID) {
    throw new Error("Flash plan is not an RP2040 UF2.");
  }
  if (productId !== 0x0003) {
    throw new Error("PICOBOOT device must be RP2040 boot (PID 0x0003).");
  }
  if (plan.eepromOverlap) {
    throw new Error("Flash plan overlaps EEPROM. Refusing erase/write.");
  }
  if (!Array.isArray(plan.payloadPages) || plan.payloadPages.length !== plan.payloadPageCount) {
    throw new Error("Flash plan payload pages are incomplete.");
  }
  if (plan.payloadPageCount < 1 || plan.writeBytes !== plan.payloadPageCount * FLASH_PAGE_SIZE) {
    throw new Error("Flash plan write size is invalid.");
  }
  if (plan.firstTargetAddr !== XIP_BASE) {
    throw new Error("Flash plan does not start at XIP_BASE (boot2).");
  }
  if (plan.hasGaps || plan.hasDuplicates || (plan.missingBlockNos && plan.missingBlockNos.length)) {
    throw new Error("Flash plan has gaps, duplicates, or missing blocks.");
  }
  assertEraseRangeSafe(plan, plan.eraseStart, plan.eraseEnd - plan.eraseStart);
  for (const page of plan.payloadPages) {
    assertPageWriteSafe(plan, page.addr, page.data);
  }
}

export function emptyFlashPlanView() {
  return {
    banner: DRY_RUN_BANNER,
    fileName: "(no UF2 selected)",
    summary: "Select a known-good MP9 UF2. Parsing stays in the browser. Flash is not modified.",
    checks: "—",
    eeprom: "Connect to Bootloader to read EEPROM[0x101FF000] (256 bytes, PC_READ only).",
  };
}

export function formatFlashPlan(plan, fileName = "") {
  if (!plan) {
    return emptyFlashPlanView().summary;
  }

  const verdict = plan.ok ? "ACCEPT (dry run only — erase/write/reboot still disabled)" : "REJECT before erase";
  const lines = [
    plan.banner,
    `Verdict: ${verdict}`,
    fileName ? `File: ${fileName}` : null,
    `Flash modified: no`,
    `Mutating PICOBOOT commands: disabled (PC_FLASH_ERASE / PC_WRITE / PC_REBOOT not sent)`,
    "",
    `UF2 family ID: ${plan.familyLabel}`,
    `RP2040判定: ${plan.isRp2040 ? "yes (0xE48BFF56)" : "no"}`,
    `Blocks: ${plan.blockCount} (declared num_blocks=${plan.declaredBlockCount})`,
    `Payload pages: ${plan.payloadPageCount}`,
    `First target address: ${plan.firstTargetAddr === null ? "—" : formatUf2Addr(plan.firstTargetAddr)}`,
    `Last target address: ${plan.lastTargetAddr === null ? "—" : formatUf2Addr(plan.lastTargetAddr)} (page start)`,
    `Last byte (exclusive): ${plan.lastTargetEnd === null ? "—" : formatUf2Addr(plan.lastTargetEnd)}`,
    `Write bytes: ${plan.writeBytes}`,
    `Write range: ${plan.writeRangeText}`,
    `Erase sectors: ${plan.eraseSectors}`,
    `Erase range: ${plan.eraseRangeText}`,
    `EEPROM reserved: ${plan.eepromRangeText}`,
    `EEPROM overlap: ${plan.eepromOverlap ? "YES — reject" : "none"}`,
    `Gaps: ${plan.hasGaps ? "yes" : "none"}`,
    `Duplicate pages: ${plan.hasDuplicates ? "yes" : "none"}`,
    `Missing block_no: ${plan.missingBlockNos.length ? plan.missingBlockNos.slice(0, 12).join(", ") : "none"}`,
    "",
    "Validations:",
    ...plan.checks.map((check) => `  [${check.status.toUpperCase()}] ${check.label} — ${check.detail}`),
  ].filter((line) => line !== null);

  if (plan.notes.length) {
    lines.push("", "Notes:", ...plan.notes.map((note) => `  ${note}`));
  }

  return lines.join("\n");
}

export { FAMILY_NAMES, familyName, formatUf2Addr, parseUf2 };
