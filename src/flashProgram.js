/**
 * Real-flash PoC orchestration.
 *
 * The UI never supplies an erase/write address. Commands are generated only
 * from a Dry Run ACCEPT plan (known Arduino UF2 or versioned MP9_V1-x.y.z.uf2).
 * PC_REBOOT is issued only after every accepted page matches the UF2 payload
 * byte-for-byte.
 */

import {
  FLASH_PAGE_SIZE,
  FLASH_SECTOR_SIZE,
  MP9_EEPROM_XIP_START,
  MP9_EEPROM_XIP_END,
  assertPlanReadyToProgram,
  bytesEqual,
  formatUf2Addr,
  isKnownMp9Uf2Name,
  plansEquivalentForProgram,
  rangeTouchesEeprom,
} from "./flashPlan.js";
import {
  EXCLUSIVE_AND_EJECT,
  MP9_EEPROM_PROBE_SIZE,
  PC_EXCLUSIVE_ACCESS,
  PC_EXIT_XIP,
  PC_FLASH_ERASE,
  PC_READ,
  PC_REBOOT,
  PC_WRITE,
  PicobootProtocolError,
  REBOOT_DELAY_MS,
  REBOOT_TO_FLASH_PC,
  REBOOT_TO_FLASH_SP,
  exclusiveArgs,
  rangeArgs,
  rebootArgs,
  resetPicobootInterface,
  sendPicobootCommand,
} from "./picoboot.js";

function firstMismatch(expected, actual) {
  const length = Math.min(expected.length, actual.length);
  for (let i = 0; i < length; i += 1) {
    if (expected[i] !== actual[i]) {
      return i;
    }
  }
  if (expected.length !== actual.length) {
    return length;
  }
  return -1;
}

function recheckEepromOnRange(start, end, label) {
  if (rangeTouchesEeprom(start, end)) {
    throw new PicobootProtocolError(
      `${label} overlaps EEPROM ${formatUf2Addr(MP9_EEPROM_XIP_START)}–${formatUf2Addr(MP9_EEPROM_XIP_END - 1)}.`,
      { commandName: label }
    );
  }
}

export function assertFinalEepromGuard(plan) {
  recheckEepromOnRange(plan.eraseStart, plan.eraseEnd, "PC_FLASH_ERASE");
  recheckEepromOnRange(plan.firstTargetAddr, plan.lastTargetEnd, "PC_WRITE");
  for (const page of plan.payloadPages) {
    recheckEepromOnRange(page.addr, page.addr + FLASH_PAGE_SIZE, "PC_WRITE");
  }
}

export function createVerifyTicket(plan, fileName) {
  return {
    verified: true,
    rebootAllowed: true,
    fileName,
    pageCount: plan.payloadPageCount,
    writeBytes: plan.writeBytes,
    eraseStart: plan.eraseStart,
    eraseEnd: plan.eraseEnd,
  };
}

/**
 * @param {object} session claimed PICOBOOT session
 * @param {{ plan: object, fileName: string, eepromBytes: Uint8Array }} accepted
 * @param {{ onProgress?: Function }} [options]
 */
export async function programAcceptedFlashPlan(session, accepted, options = {}) {
  const plan = accepted?.plan;
  const fileName = accepted?.fileName;
  const eepromBytes = accepted?.eepromBytes;
  const livePlan = accepted?.livePlan;
  const onProgress = options.onProgress || (() => {});

  if (session?.info?.productId !== 0x0003) {
    throw new PicobootProtocolError("Flash write PoC is RP2040 boot (PID 0x0003) only.", {
      commandName: "PC_FLASH_ERASE",
    });
  }
  if (!isKnownMp9Uf2Name(fileName)) {
    throw new PicobootProtocolError(
      `Flash write PoC only accepts MP9_V1.ino.uf2 or MP9_V1-<major>.<minor>.<patch>.uf2. Got ${JSON.stringify(fileName || "")}.`,
      {
        commandName: "PC_WRITE",
      }
    );
  }
  if (livePlan && !plansEquivalentForProgram(plan, livePlan)) {
    throw new PicobootProtocolError("Selected UF2 no longer matches the Dry Run ACCEPT plan. Re-run Dry Run.", {
      commandName: "PC_WRITE",
    });
  }
  if (!(eepromBytes instanceof Uint8Array) || eepromBytes.length !== MP9_EEPROM_PROBE_SIZE) {
    throw new PicobootProtocolError("Pre-update EEPROM probe (256 bytes) is required before erase/write.", {
      commandName: "PC_READ",
    });
  }

  assertPlanReadyToProgram(plan, { fileName, productId: session.info.productId });
  assertFinalEepromGuard(plan);

  const gate = { kind: "program", plan };
  const eraseSize = plan.eraseEnd - plan.eraseStart;

  await resetPicobootInterface(session);

  onProgress({
    phase: "exclusive",
    commandName: "PC_EXCLUSIVE_ACCESS",
    detail: "EXCLUSIVE_AND_EJECT",
    current: 0,
    total: 1,
  });
  await sendPicobootCommand(
    session,
    {
      cmdId: PC_EXCLUSIVE_ACCESS,
      cmdSize: 1,
      transferLength: 0,
      args: exclusiveArgs(EXCLUSIVE_AND_EJECT),
    },
    gate
  );

  onProgress({
    phase: "exit-xip",
    commandName: "PC_EXIT_XIP",
    detail: "SPI flash access",
    current: 0,
    total: 1,
  });
  await sendPicobootCommand(
    session,
    {
      cmdId: PC_EXIT_XIP,
      cmdSize: 0,
      transferLength: 0,
      args: new Uint8Array(0),
    },
    gate
  );

  assertFinalEepromGuard(plan);
  assertEraseRangeSafeForLog(plan, eraseSize);
  onProgress({
    phase: "erase",
    commandName: "PC_FLASH_ERASE",
    detail: `${plan.eraseSectors} sectors ${formatUf2Addr(plan.eraseStart)}–${formatUf2Addr(plan.eraseEnd)}`,
    current: 0,
    total: plan.eraseSectors,
  });
  await sendPicobootCommand(
    session,
    {
      cmdId: PC_FLASH_ERASE,
      cmdSize: 8,
      transferLength: 0,
      args: rangeArgs(plan.eraseStart, eraseSize),
    },
    gate
  );

  const pages = plan.payloadPages;
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    onProgress({
      phase: "write",
      commandName: "PC_WRITE",
      detail: formatUf2Addr(page.addr),
      current: i + 1,
      total: pages.length,
    });
    await sendPicobootCommand(
      session,
      {
        cmdId: PC_WRITE,
        cmdSize: 8,
        transferLength: FLASH_PAGE_SIZE,
        args: rangeArgs(page.addr, FLASH_PAGE_SIZE),
        data: page.data,
      },
      gate
    );
  }

  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    onProgress({
      phase: "verify",
      commandName: "PC_READ",
      detail: formatUf2Addr(page.addr),
      current: i + 1,
      total: pages.length,
    });
    const result = await sendPicobootCommand(
      session,
      {
        cmdId: PC_READ,
        cmdSize: 8,
        transferLength: FLASH_PAGE_SIZE,
        args: rangeArgs(page.addr, FLASH_PAGE_SIZE),
      },
      gate
    );
    const mismatch = firstMismatch(page.data, result.payload);
    if (mismatch >= 0) {
      throw new PicobootProtocolError(
        `Verify failed at ${formatUf2Addr(page.addr)} + ${mismatch}. Staying in BOOTSEL (no reboot).`,
        {
          commandName: "PC_READ",
          transferredBytes: result.payload.length,
          responseText: `expected 0x${page.data[mismatch].toString(16)} got 0x${(result.payload[mismatch] ?? 0).toString(16)}`,
        }
      );
    }
  }

  onProgress({
    phase: "eeprom-check",
    commandName: "PC_READ",
    detail: "EEPROM post-verify compare",
    current: 1,
    total: 1,
  });
  const eepromAfter = await sendPicobootCommand(
    session,
    {
      cmdId: PC_READ,
      cmdSize: 8,
      transferLength: MP9_EEPROM_PROBE_SIZE,
      args: rangeArgs(MP9_EEPROM_XIP_START, MP9_EEPROM_PROBE_SIZE),
    },
    gate
  );
  if (!bytesEqual(eepromBytes, eepromAfter.payload)) {
    throw new PicobootProtocolError(
      "EEPROM changed during firmware write. Staying in BOOTSEL (no reboot).",
      { commandName: "PC_READ", transferredBytes: eepromAfter.payload.length }
    );
  }

  const ticket = createVerifyTicket(plan, fileName);
  onProgress({
    phase: "verified",
    commandName: "verify",
    detail: `${pages.length} pages matched; EEPROM unchanged; reboot now allowed`,
    current: pages.length,
    total: pages.length,
  });
  return {
    ticket,
    pageCount: pages.length,
    writeBytes: plan.writeBytes,
    eraseSectors: plan.eraseSectors,
    eepromUnchanged: true,
  };
}

function assertEraseRangeSafeForLog(plan, eraseSize) {
  if (eraseSize !== plan.eraseSectors * FLASH_SECTOR_SIZE) {
    throw new PicobootProtocolError("Erase size does not match the accepted sector count.", {
      commandName: "PC_FLASH_ERASE",
    });
  }
}

function looksLikeRebootDisconnect(error) {
  const message = error && error.message ? error.message : String(error);
  return /disconnect|not found|no device|networkerror|the device was/i.test(message);
}

/**
 * Reboot only with a ticket from programAcceptedFlashPlan. On erase/write/verify
 * failure the caller must not invoke this, so the device stays in BOOTSEL.
 */
export async function rebootAfterVerifiedFlash(session, ticket) {
  if (!ticket?.verified || !ticket?.rebootAllowed) {
    throw new PicobootProtocolError("PC_REBOOT is forbidden until verify succeeds.", {
      commandName: "PC_REBOOT",
    });
  }
  try {
    await sendPicobootCommand(
      session,
      {
        cmdId: PC_REBOOT,
        cmdSize: 12,
        transferLength: 0,
        args: rebootArgs(REBOOT_TO_FLASH_PC, REBOOT_TO_FLASH_SP, REBOOT_DELAY_MS),
      },
      { kind: "reboot", ticket }
    );
  } catch (error) {
    if (!looksLikeRebootDisconnect(error)) {
      throw error;
    }
  }
  return {
    commandName: "PC_REBOOT",
    commandStatus: "issued (device should leave BOOTSEL)",
    response: `pc=${REBOOT_TO_FLASH_PC} sp=${REBOOT_TO_FLASH_SP} delayMs=${REBOOT_DELAY_MS}`,
    transferredBytes: "0",
    protocolError: "—",
    ok: true,
  };
}
