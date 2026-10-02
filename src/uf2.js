/**
 * UF2 block parser for the MP9 flash-plan dry run.
 *
 * Layout and magics: Microsoft UF2 (MIT) and pico-sdk boot/uf2.h (BSD-3-Clause).
 * GPLv3 hosts were not copied.
 */

export const UF2_BLOCK_SIZE = 512;
export const UF2_PAYLOAD_MAX = 476;

export const UF2_MAGIC_START0 = 0x0a324655;
export const UF2_MAGIC_START1 = 0x9e5d5157;
export const UF2_MAGIC_END = 0x0ab16f30;

export const UF2_FLAG_NOT_MAIN_FLASH = 0x00000001;
export const UF2_FLAG_FILE_CONTAINER = 0x00001000;
export const UF2_FLAG_FAMILY_ID_PRESENT = 0x00002000;
export const UF2_FLAG_MD5_PRESENT = 0x00004000;
export const UF2_FLAG_EXTENSION_TAGS = 0x00008000;

/** pico-sdk src/common/boot_uf2_headers/include/boot/uf2.h */
export const RP2040_FAMILY_ID = 0xe48bff56;
export const ABSOLUTE_FAMILY_ID = 0xe48bff57;
export const DATA_FAMILY_ID = 0xe48bff58;
export const RP2350_ARM_S_FAMILY_ID = 0xe48bff59;
export const RP2350_RISCV_FAMILY_ID = 0xe48bff5a;
export const RP2350_ARM_NS_FAMILY_ID = 0xe48bff5b;
export const FAMILY_ID_DATA = DATA_FAMILY_ID;

export const FAMILY_NAMES = Object.freeze({
  [RP2040_FAMILY_ID]: "RP2040",
  [ABSOLUTE_FAMILY_ID]: "ABSOLUTE",
  [DATA_FAMILY_ID]: "DATA",
  [RP2350_ARM_S_FAMILY_ID]: "RP2350 ARM Secure",
  [RP2350_RISCV_FAMILY_ID]: "RP2350 RISC-V",
  [RP2350_ARM_NS_FAMILY_ID]: "RP2350 ARM Non-Secure",
});

export function familyName(familyId) {
  if (familyId === null || familyId === undefined) {
    return "(missing)";
  }
  return FAMILY_NAMES[familyId >>> 0] || "unknown";
}

export function formatUf2Addr(value) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function issue(code, message, extra = {}) {
  return { code, message, ...extra };
}

function parseBlock(bytes, index, fileOffset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + fileOffset, UF2_BLOCK_SIZE);
  const magicStart0 = view.getUint32(0, true);
  const magicStart1 = view.getUint32(4, true);
  const flags = view.getUint32(8, true);
  const targetAddr = view.getUint32(12, true);
  const payloadSize = view.getUint32(16, true);
  const blockNo = view.getUint32(20, true);
  const numBlocks = view.getUint32(24, true);
  const fileSizeOrFamily = view.getUint32(28, true);
  const magicEnd = view.getUint32(508, true);
  const familyPresent = (flags & UF2_FLAG_FAMILY_ID_PRESENT) !== 0;

  const payload = bytes.subarray(fileOffset + 32, fileOffset + 32 + Math.min(payloadSize, UF2_PAYLOAD_MAX));

  return {
    index,
    fileOffset,
    magicStart0,
    magicStart1,
    magicEnd,
    flags,
    targetAddr,
    payloadSize,
    blockNo,
    numBlocks,
    fileSizeOrFamily,
    familyId: familyPresent ? fileSizeOrFamily >>> 0 : null,
    familyPresent,
    notMainFlash: (flags & UF2_FLAG_NOT_MAIN_FLASH) !== 0,
    fileContainer: (flags & UF2_FLAG_FILE_CONTAINER) !== 0,
    magicOk:
      magicStart0 === UF2_MAGIC_START0 &&
      magicStart1 === UF2_MAGIC_START1 &&
      magicEnd === UF2_MAGIC_END,
    payload,
  };
}

/**
 * Parse a UF2 file in memory. Does not touch USB or flash.
 */
export function parseUf2(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const issues = [];
  const fileBytes = bytes.byteLength;

  if (fileBytes === 0) {
    issues.push(issue("file_geometry", "File is empty."));
    return { ok: false, fileBytes, declaredBlockCount: 0, blocks: [], issues };
  }

  if (fileBytes % UF2_BLOCK_SIZE !== 0) {
    issues.push(
      issue(
        "file_geometry",
        `File length ${fileBytes} is not a multiple of ${UF2_BLOCK_SIZE} (remainder ${fileBytes % UF2_BLOCK_SIZE}).`
      )
    );
  }

  const sliceCount = Math.floor(fileBytes / UF2_BLOCK_SIZE);
  if (sliceCount < 1) {
    issues.push(issue("file_geometry", "File is shorter than one 512-byte UF2 block."));
    return { ok: false, fileBytes, declaredBlockCount: 0, blocks: [], issues };
  }

  const blocks = [];
  for (let i = 0; i < sliceCount; i += 1) {
    const block = parseBlock(bytes, i, i * UF2_BLOCK_SIZE);
    blocks.push(block);
    if (!block.magicOk) {
      issues.push(
        issue(
          "magic",
          `Block ${i} has invalid UF2 magics (start0=${formatUf2Addr(block.magicStart0)}, start1=${formatUf2Addr(block.magicStart1)}, end=${formatUf2Addr(block.magicEnd)}).`
        )
      );
    }
    if (block.payloadSize > UF2_PAYLOAD_MAX) {
      issues.push(issue("payload", `Block ${i} payload_size ${block.payloadSize} exceeds ${UF2_PAYLOAD_MAX}.`));
    }
  }

  const declared = blocks.map((block) => block.numBlocks);
  const declaredBlockCount = declared[0] || 0;
  const mixedNumBlocks = declared.some((value) => value !== declaredBlockCount);
  if (mixedNumBlocks) {
    issues.push(issue("file_geometry", "Blocks disagree on num_blocks."));
  }
  if (declaredBlockCount !== sliceCount) {
    issues.push(
      issue(
        "file_geometry",
        `num_blocks is ${declaredBlockCount}, but the file contains ${sliceCount} × 512-byte records.`
      )
    );
  }

  return {
    ok: issues.length === 0,
    fileBytes,
    declaredBlockCount,
    sliceCount,
    blocks,
    issues,
  };
}
