/**
 * Phase 2 PoC: WebUSB claim of the RP2040/RP2350 ROM PICOBOOT vendor interface,
 * plus gated PICOBOOT commands.
 *
 * Dry-run may send PC_EXIT_XIP then PC_READ of the MP9 EEPROM page.
 * Flash erase/write/reboot are allowed only through flashProgram.js, which
 * feeds a Dry Run ACCEPT plan. Arbitrary address erase/write is not exported
 * for the UI.
 *
 * USB IDs: Raspberry Pi usb-pid list
 *   RP2040 boot  VID 0x2E8A PID 0x0003
 *   RP2350 boot  VID 0x2E8A PID 0x000F
 *
 * Protocol (primary sources, BSD-3-Clause):
 *   raspberrypi/pico-bootrom-rp2040  bootrom/usb_boot_device.c
 *   raspberrypi/pico-sdk             boot/picoboot.h
 * Host transfer order was cross-checked against raspberrypi/picotool
 * picoboot_connection.c (BSD-3-Clause). GPLv3 hosts were not copied.
 *
 * USBAlternateInterface has class/subclass/protocol/endpoints, but
 * interfaceNumber lives on USBInterface. Claiming the alternate object’s
 * missing interfaceNumber used to coerce to 0 (MSC) and fail with
 * "The requested interface implements a protected class."
 *
 * Discovery approach follows descriptor inspection used by MIT WebUSB
 * picoboot hosts (piersfinlayson/picoflash and related picoboot-webusb):
 * enumerate configuration.interfaces, inspect each alternate, skip protected
 * classes, take vendor 0xFF with a bulk IN+OUT pair.
 */

import {
  FLASH_PAGE_SIZE,
  assertEraseRangeSafe,
  assertPageReadSafe,
  assertPageWriteSafe,
} from "./flashPlan.js";

export const RP_USB_VID = 0x2e8a;
export const RP2040_BOOT_PID = 0x0003;
export const RP2350_BOOT_PID = 0x000f;

export const USB_CLASS_MASS_STORAGE = 0x08;
export const USB_CLASS_VENDOR_SPECIFIC = 0xff;

/** Chromium WebUSB protected interface classes (cannot claimInterface). */
export const WEBUSB_PROTECTED_CLASSES = Object.freeze([
  0x01, // Audio
  0x03, // HID
  0x08, // Mass Storage
  0x0b, // Smart Card
  0x0e, // Video
  0x10, // Audio/Video
  0xe0, // Wireless Controller
]);

export const BOOTLOADER_FILTERS = Object.freeze([
  { vendorId: RP_USB_VID, productId: RP2040_BOOT_PID },
  { vendorId: RP_USB_VID, productId: RP2350_BOOT_PID },
]);

/** pico-sdk boot/picoboot.h — 32-byte command magic. */
export const PICOBOOT_MAGIC = 0x431fd10b;
export const PICOBOOT_CMD_SIZE = 32;
export const PICOBOOT_STATUS_SIZE = 16;

/** Vendor control requests on the PICOBOOT interface (picoboot.h). */
export const PICOBOOT_IF_RESET = 0x41;
export const PICOBOOT_IF_CMD_STATUS = 0x42;

export const PC_EXCLUSIVE_ACCESS = 0x01;
export const PC_REBOOT = 0x02;
export const PC_FLASH_ERASE = 0x03;
export const PC_READ = 0x84;
export const PC_WRITE = 0x05;
export const PC_EXIT_XIP = 0x06;
export const PC_ENTER_CMD_XIP = 0x07;
export const PC_EXEC = 0x08;
export const PC_VECTORIZE_FLASH = 0x09;
export const PC_REBOOT2 = 0x0a;
export const PC_GET_INFO = 0x8b;
export const PC_OTP_READ = 0x8c;
export const PC_OTP_WRITE = 0x0d;

export const PICOBOOT_OK = 0;

/** pico-sdk picoboot_exclusive_type */
export const EXCLUSIVE_NOT = 0;
export const EXCLUSIVE = 1;
export const EXCLUSIVE_AND_EJECT = 2;

/** PC_REBOOT: dPC=0 / dSP=0 means the regular flash boot path. */
export const REBOOT_TO_FLASH_PC = 0;
export const REBOOT_TO_FLASH_SP = 0;
export const REBOOT_DELAY_MS = 500;

export const ALWAYS_BLOCKED_PICOBOOT_CMDS = Object.freeze({
  [PC_ENTER_CMD_XIP]: "PC_ENTER_CMD_XIP",
  [PC_EXEC]: "PC_EXEC",
  [PC_VECTORIZE_FLASH]: "PC_VECTORIZE_FLASH",
  [PC_REBOOT2]: "PC_REBOOT2",
  [PC_GET_INFO]: "PC_GET_INFO",
  [PC_OTP_READ]: "PC_OTP_READ",
  [PC_OTP_WRITE]: "PC_OTP_WRITE",
});

export const PICOBOOT_STATUS_NAMES = Object.freeze({
  0: "PICOBOOT_OK",
  1: "PICOBOOT_UNKNOWN_CMD",
  2: "PICOBOOT_INVALID_CMD_LENGTH",
  3: "PICOBOOT_INVALID_TRANSFER_LENGTH",
  4: "PICOBOOT_INVALID_ADDRESS",
  5: "PICOBOOT_BAD_ALIGNMENT",
  6: "PICOBOOT_INTERLEAVED_WRITE",
  7: "PICOBOOT_REBOOTING",
  8: "PICOBOOT_UNKNOWN_ERROR",
  9: "PICOBOOT_INVALID_STATE",
  10: "PICOBOOT_NOT_PERMITTED",
  11: "PICOBOOT_INVALID_ARG",
  12: "PICOBOOT_BUFFER_TOO_SMALL",
  13: "PICOBOOT_PRECONDITION_NOT_MET",
  14: "PICOBOOT_MODIFIED_DATA",
  15: "PICOBOOT_INVALID_DATA",
  16: "PICOBOOT_NOT_FOUND",
  17: "PICOBOOT_UNSUPPORTED_MODIFICATION",
});

export const PICOBOOT_CMD_NAMES = Object.freeze({
  [PC_EXCLUSIVE_ACCESS]: "PC_EXCLUSIVE_ACCESS",
  [PC_REBOOT]: "PC_REBOOT",
  [PC_FLASH_ERASE]: "PC_FLASH_ERASE",
  [PC_READ]: "PC_READ",
  [PC_WRITE]: "PC_WRITE",
  [PC_EXIT_XIP]: "PC_EXIT_XIP",
  [PC_ENTER_CMD_XIP]: "PC_ENTER_CMD_XIP",
  [PC_EXEC]: "PC_EXEC",
  [PC_VECTORIZE_FLASH]: "PC_VECTORIZE_FLASH",
  [PC_REBOOT2]: "PC_REBOOT2",
  [PC_GET_INFO]: "PC_GET_INFO",
  [PC_OTP_READ]: "PC_OTP_READ",
  [PC_OTP_WRITE]: "PC_OTP_WRITE",
});

/**
 * RP2040 boot ROM window from pico-bootrom-rp2040 bootrom.ld:
 *   ROM(rx) : ORIGIN = 0x00000000, LENGTH = 16K
 * and pico-sdk rp2040 addressmap.h ROM_BASE.
 *
 * PC_READ of this range is memcpy from ROM (async_task.c, AT_READ + is_address_rom).
 * The first 16 bytes are the Cortex-M0+ vector table (KEEP(*(.vectors))).
 */
export const RP2040_ROM_BASE = 0x00000000;
export const RP2040_ROM_SIZE = 16 * 1024;
export const PICOBOOT_POC_READ_ADDR = RP2040_ROM_BASE;
export const PICOBOOT_POC_READ_SIZE = 16;

/** Arduino-Pico EEPROM sector on RP2040-Zero 2 MiB flash (last 4 KiB). */
export const MP9_EEPROM_XIP_START = 0x101ff000;
export const MP9_EEPROM_PROBE_SIZE = 256;

const CONTROL_TIMEOUT_MS = 1000;
const CMD_OUT_TIMEOUT_MS = 3000;
const DATA_TIMEOUT_MS = 10000;
const ACK_TIMEOUT_MS = 3000;
const ERASE_ACK_TIMEOUT_MS = 30000;

let nextPicobootToken = 1;

export class PicobootProtocolError extends Error {
  constructor(message, extras = {}) {
    super(message);
    this.name = "PicobootProtocolError";
    this.commandName = extras.commandName || "—";
    this.statusCode = extras.statusCode;
    this.statusName = extras.statusName || "—";
    this.transferredBytes = extras.transferredBytes ?? 0;
    this.responseText = extras.responseText || "—";
  }
}

export function isWebUsbSupported() {
  return Boolean(navigator.usb && typeof navigator.usb.requestDevice === "function");
}

export function formatUsbId(value) {
  return `0x${Number(value).toString(16).toUpperCase().padStart(4, "0")}`;
}

export function formatUsbClass(value) {
  return `0x${Number(value).toString(16).toUpperCase().padStart(2, "0")}`;
}

export function chipNameForPid(productId) {
  if (productId === RP2040_BOOT_PID) {
    return "RP2040";
  }
  if (productId === RP2350_BOOT_PID) {
    return "RP2350";
  }
  return "unknown";
}

export function isProtectedUsbClass(interfaceClass) {
  return WEBUSB_PROTECTED_CLASSES.includes(Number(interfaceClass));
}

export function picobootCommandName(cmdId) {
  return PICOBOOT_CMD_NAMES[cmdId] || `UNKNOWN_CMD_0x${Number(cmdId).toString(16).toUpperCase()}`;
}

export function picobootStatusName(statusCode) {
  if (statusCode === undefined || statusCode === null) {
    return "—";
  }
  return PICOBOOT_STATUS_NAMES[statusCode] || `UNKNOWN_STATUS_${statusCode}`;
}

function endpointSummary(endpoint) {
  const dir = endpoint.direction === "in" ? "IN" : "OUT";
  const addr =
    endpoint.direction === "in"
      ? 0x80 | Number(endpoint.endpointNumber)
      : Number(endpoint.endpointNumber);
  return `${dir} 0x${addr.toString(16).toUpperCase()} ${endpoint.type} max ${endpoint.packetSize}`;
}

function bulkEndpointNumbers(endpoints) {
  const list = endpoints || [];
  const inn = list.find((endpoint) => endpoint.direction === "in" && endpoint.type === "bulk");
  const out = list.find((endpoint) => endpoint.direction === "out" && endpoint.type === "bulk");
  return {
    inEndpointNumber: inn ? Number(inn.endpointNumber) : null,
    outEndpointNumber: out ? Number(out.endpointNumber) : null,
  };
}

function hasBulkPair(endpoints) {
  const numbers = bulkEndpointNumbers(endpoints);
  return numbers.inEndpointNumber !== null && numbers.outEndpointNumber !== null;
}

export function listInterfaceAlternates(device) {
  const configuration = device.configuration;
  if (!configuration) {
    return [];
  }

  const rows = [];
  for (const usbInterface of configuration.interfaces) {
    const alternates = usbInterface.alternates || [];
    for (const alternate of alternates) {
      const interfaceClass = Number(alternate.interfaceClass);
      const protectedClass = isProtectedUsbClass(interfaceClass);
      const vendor = interfaceClass === USB_CLASS_VENDOR_SPECIFIC;
      const bulkPair = hasBulkPair(alternate.endpoints);
      const numbers = bulkEndpointNumbers(alternate.endpoints);
      rows.push({
        interfaceNumber: usbInterface.interfaceNumber,
        alternateSetting: alternate.alternateSetting,
        interfaceClass,
        interfaceSubclass: Number(alternate.interfaceSubclass),
        interfaceProtocol: Number(alternate.interfaceProtocol),
        endpoints: (alternate.endpoints || []).map(endpointSummary),
        inEndpointNumber: numbers.inEndpointNumber,
        outEndpointNumber: numbers.outEndpointNumber,
        protectedClass,
        vendorSpecific: vendor,
        bulkPair,
        picobootCandidate: vendor && bulkPair && !protectedClass,
      });
    }
  }
  return rows;
}

export function formatInterfaceDump(rows) {
  if (!rows.length) {
    return "(no interfaces — device.configuration is empty)";
  }
  return rows
    .map((row) => {
      const flags = [];
      if (row.protectedClass) {
        flags.push("protected");
      }
      if (row.picobootCandidate) {
        flags.push("PICOBOOT candidate");
      } else if (row.vendorSpecific) {
        flags.push("vendor 0xFF");
      }
      if (row.interfaceClass === USB_CLASS_MASS_STORAGE) {
        flags.push("MSC");
      }
      const flagText = flags.length ? ` [${flags.join(", ")}]` : "";
      return [
        `iface ${row.interfaceNumber}`,
        `alt ${row.alternateSetting}`,
        `class=${formatUsbClass(row.interfaceClass)}`,
        `subclass=${formatUsbClass(row.interfaceSubclass)}`,
        `protocol=${formatUsbClass(row.interfaceProtocol)}`,
        `endpoints=[${row.endpoints.join("; ") || "none"}]`,
      ].join(" ") + flagText;
    })
    .join("\n");
}

export function findPicobootInterface(rows) {
  const candidates = rows.filter((row) => row.picobootCandidate);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.find((row) => row.interfaceNumber > 0) || candidates[0];
}

function inspectDevice(device, claimed, rows) {
  const configuration = device.configuration;
  return {
    ok: true,
    productName: device.productName || "(none)",
    manufacturerName: device.manufacturerName || "(none)",
    serialNumber: device.serialNumber || "(none)",
    vendorId: device.vendorId,
    productId: device.productId,
    vidPid: `${formatUsbId(device.vendorId)} / ${formatUsbId(device.productId)}`,
    chip: chipNameForPid(device.productId),
    configurationValue: configuration ? configuration.configurationValue : null,
    claimedInterfaceNumber: claimed ? claimed.interfaceNumber : null,
    claimedAlternateSetting: claimed ? claimed.alternateSetting : null,
    claimedClass: claimed ? claimed.interfaceClass : null,
    claimedSubclass: claimed ? claimed.interfaceSubclass : null,
    claimedProtocol: claimed ? claimed.interfaceProtocol : null,
    claimedEndpoints: claimed ? claimed.endpoints : [],
    inEndpointNumber: claimed ? claimed.inEndpointNumber : null,
    outEndpointNumber: claimed ? claimed.outEndpointNumber : null,
    interfaceDump: formatInterfaceDump(rows),
    interfaces: rows,
  };
}

export async function requestAndClaimPicoboot() {
  if (!isWebUsbSupported()) {
    throw new Error("WebUSB is not available. Use Chrome or Edge on HTTPS or localhost.");
  }

  const device = await navigator.usb.requestDevice({ filters: [...BOOTLOADER_FILTERS] });
  let rows = [];

  try {
    await device.open();
    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }

    rows = listInterfaceAlternates(device);
    console.info("RP2 Boot USB interfaces (before claimInterface)", rows);
    console.info(formatInterfaceDump(rows));

    const picoboot = findPicobootInterface(rows);
    if (!picoboot) {
      const error = new Error(
        "Opened RP2 Boot, but no claimable vendor-specific (0xFF) PICOBOOT interface was found. MSC/protected classes are skipped."
      );
      error.interfaceDump = formatInterfaceDump(rows);
      throw error;
    }

    if (!Number.isInteger(picoboot.interfaceNumber)) {
      const error = new Error(
        `PICOBOOT candidate is missing a numeric interfaceNumber (${picoboot.interfaceNumber}). Refusing to claim (that would hit interface 0 / MSC).`
      );
      error.interfaceDump = formatInterfaceDump(rows);
      throw error;
    }

    if (isProtectedUsbClass(picoboot.interfaceClass)) {
      const error = new Error(
        `Refusing to claim protected USB class ${formatUsbClass(picoboot.interfaceClass)} on interface ${picoboot.interfaceNumber}.`
      );
      error.interfaceDump = formatInterfaceDump(rows);
      throw error;
    }

    await device.claimInterface(picoboot.interfaceNumber);
    if (picoboot.alternateSetting) {
      await device.selectAlternateInterface(picoboot.interfaceNumber, picoboot.alternateSetting);
    }

    return {
      device,
      info: inspectDevice(device, picoboot, rows),
      transport: {
        interfaceNumber: picoboot.interfaceNumber,
        outEndpointNumber: picoboot.outEndpointNumber,
        inEndpointNumber: picoboot.inEndpointNumber,
      },
    };
  } catch (error) {
    if (error && !error.interfaceDump) {
      error.interfaceDump = formatInterfaceDump(rows);
    }
    try {
      if (device.opened) {
        await device.close();
      }
    } catch (_closeError) {
      // Keep the original claim/open error.
    }
    throw error;
  }
}

export async function releasePicoboot(device) {
  if (!device) {
    return;
  }
  try {
    if (device.opened) {
      await device.close();
    }
  } catch (_error) {
    // Already gone after unplug / BOOTSEL exit.
  }
}

export function isUserCancelledUsb(error) {
  return Boolean(error && (error.name === "NotFoundError" || /no device selected/i.test(String(error.message || error))));
}

export function emptyPicobootProtocolInfo() {
  return {
    commandName: "—",
    commandStatus: "—",
    response: "—",
    transferredBytes: "—",
    protocolError: "—",
  };
}

function allocateToken() {
  const token = nextPicobootToken >>> 0;
  nextPicobootToken = (nextPicobootToken + 1) >>> 0;
  if (nextPicobootToken === 0) {
    nextPicobootToken = 1;
  }
  return token;
}

async function withTimeout(promise, ms, label) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => {
      reject(
        new PicobootProtocolError(`PICOBOOT timeout: ${label} (${ms} ms)`, {
          commandName: label,
        })
      );
    }, ms);
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

function requireTransport(session) {
  const device = session?.device;
  const transport = session?.transport;
  if (!device?.opened || !transport) {
    throw new PicobootProtocolError("PICOBOOT interface is not claimed.");
  }
  if (!Number.isInteger(transport.interfaceNumber)) {
    throw new PicobootProtocolError("PICOBOOT interfaceNumber is missing.");
  }
  if (!Number.isInteger(transport.outEndpointNumber) || !Number.isInteger(transport.inEndpointNumber)) {
    throw new PicobootProtocolError("PICOBOOT bulk endpoints were not found on the claimed interface.");
  }
  return { device, transport };
}

function wrapGateError(error, commandName) {
  if (error instanceof PicobootProtocolError) {
    return error;
  }
  return new PicobootProtocolError(error && error.message ? error.message : String(error), {
    commandName,
  });
}

function exclusiveTypeFromArgs(args) {
  const bytes = args || new Uint8Array(0);
  if (bytes.length < 1) {
    throw new PicobootProtocolError("PC_EXCLUSIVE_ACCESS requires bExclusive.", {
      commandName: "PC_EXCLUSIVE_ACCESS",
    });
  }
  return bytes[0];
}

function rebootArgsFrom(args) {
  const bytes = args || new Uint8Array(0);
  if (bytes.length < 12) {
    throw new PicobootProtocolError("PC_REBOOT args must include pc, sp, delayMs.", {
      commandName: "PC_REBOOT",
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    pc: view.getUint32(0, true),
    sp: view.getUint32(4, true),
    delayMs: view.getUint32(8, true),
  };
}

export function assertPicobootCommandGate(cmdId, gate, extra = {}) {
  const blocked = ALWAYS_BLOCKED_PICOBOOT_CMDS[cmdId];
  if (blocked) {
    throw new PicobootProtocolError(`${blocked} is not enabled in this PoC.`, { commandName: blocked });
  }

  const kind = gate && gate.kind;
  if (!kind) {
    throw new PicobootProtocolError("PICOBOOT command refused: missing safety gate.", {
      commandName: picobootCommandName(cmdId),
    });
  }

  if (kind === "rom-test") {
    if (cmdId !== PC_READ) {
      throw new PicobootProtocolError("ROM test gate allows PC_READ of the vector table only.", {
        commandName: picobootCommandName(cmdId),
      });
    }
    assertSafeRead(extra.addr, extra.size);
    if (!isAllowedRomRead(extra.addr, extra.size)) {
      throw new PicobootProtocolError("ROM test gate refuses this read range.", { commandName: "PC_READ" });
    }
    return;
  }

  if (kind === "eeprom-probe") {
    if (cmdId !== PC_READ && cmdId !== PC_EXIT_XIP) {
      throw new PicobootProtocolError("EEPROM probe gate allows PC_EXIT_XIP and EEPROM PC_READ only.", {
        commandName: picobootCommandName(cmdId),
      });
    }
    if (cmdId === PC_READ) {
      assertSafeRead(extra.addr, extra.size);
      if (!isAllowedEepromRead(extra.addr, extra.size)) {
        throw new PicobootProtocolError("EEPROM probe gate refuses this read range.", { commandName: "PC_READ" });
      }
    }
    return;
  }

  if (kind === "program") {
    const plan = gate.plan;
    if (!plan?.ok) {
      throw new PicobootProtocolError("Program gate requires a Dry Run ACCEPT plan.", {
        commandName: picobootCommandName(cmdId),
      });
    }
    if (
      cmdId !== PC_EXCLUSIVE_ACCESS &&
      cmdId !== PC_EXIT_XIP &&
      cmdId !== PC_FLASH_ERASE &&
      cmdId !== PC_WRITE &&
      cmdId !== PC_READ
    ) {
      throw new PicobootProtocolError("Program gate does not allow this command (reboot is a separate gate).", {
        commandName: picobootCommandName(cmdId),
      });
    }
    if (cmdId === PC_EXCLUSIVE_ACCESS) {
      const exclusive = extra.exclusiveType;
      if (exclusive !== EXCLUSIVE_AND_EJECT) {
        throw new PicobootProtocolError("PC_EXCLUSIVE_ACCESS is limited to EXCLUSIVE_AND_EJECT.", {
          commandName: "PC_EXCLUSIVE_ACCESS",
        });
      }
      return;
    }
    if (cmdId === PC_FLASH_ERASE) {
      try {
        assertEraseRangeSafe(plan, extra.addr, extra.size);
      } catch (error) {
        throw wrapGateError(error, "PC_FLASH_ERASE");
      }
      return;
    }
    if (cmdId === PC_WRITE) {
      try {
        assertPageWriteSafe(plan, extra.addr, extra.data);
      } catch (error) {
        throw wrapGateError(error, "PC_WRITE");
      }
      if (extra.size !== FLASH_PAGE_SIZE) {
        throw new PicobootProtocolError("PC_WRITE is limited to accepted 256-byte pages.", {
          commandName: "PC_WRITE",
        });
      }
      return;
    }
    if (cmdId === PC_READ) {
      if (isAllowedEepromRead(extra.addr, extra.size)) {
        return;
      }
      try {
        assertPageReadSafe(plan, extra.addr, extra.size);
      } catch (error) {
        throw wrapGateError(error, "PC_READ");
      }
    }
    return;
  }

  if (kind === "reboot") {
    if (cmdId !== PC_REBOOT) {
      throw new PicobootProtocolError("Reboot gate allows PC_REBOOT only.", {
        commandName: picobootCommandName(cmdId),
      });
    }
    if (!gate.ticket?.verified || !gate.ticket?.rebootAllowed) {
      throw new PicobootProtocolError("PC_REBOOT is forbidden until byte-for-byte verify succeeds.", {
        commandName: "PC_REBOOT",
      });
    }
    const reboot = extra.reboot || {};
    if (reboot.pc !== REBOOT_TO_FLASH_PC || reboot.sp !== REBOOT_TO_FLASH_SP) {
      throw new PicobootProtocolError("PC_REBOOT is limited to the regular flash boot path (pc=0, sp=0).", {
        commandName: "PC_REBOOT",
      });
    }
    if (reboot.delayMs !== REBOOT_DELAY_MS) {
      throw new PicobootProtocolError(`PC_REBOOT delay must be ${REBOOT_DELAY_MS} ms.`, {
        commandName: "PC_REBOOT",
      });
    }
    return;
  }

  throw new PicobootProtocolError(`Unknown PICOBOOT safety gate ${kind}.`, {
    commandName: picobootCommandName(cmdId),
  });
}

function isAllowedRomRead(addr, size) {
  return addr === PICOBOOT_POC_READ_ADDR && size === PICOBOOT_POC_READ_SIZE;
}

function isAllowedEepromRead(addr, size) {
  return addr === MP9_EEPROM_XIP_START && size === MP9_EEPROM_PROBE_SIZE;
}

function assertSafeRead(addr, size) {
  if (isAllowedRomRead(addr, size)) {
    const end = addr + size;
    if (addr < RP2040_ROM_BASE || end > RP2040_ROM_BASE + RP2040_ROM_SIZE) {
      throw new PicobootProtocolError("Read range is outside the RP2040 boot ROM window from bootrom.ld.", {
        commandName: "PC_READ",
      });
    }
    return;
  }
  if (isAllowedEepromRead(addr, size)) {
    return;
  }
  throw new PicobootProtocolError(
    `PC_READ is limited to ROM ${formatUsbId(PICOBOOT_POC_READ_ADDR)}+${PICOBOOT_POC_READ_SIZE} or EEPROM ${formatUf2Style(MP9_EEPROM_XIP_START)}+${MP9_EEPROM_PROBE_SIZE}. Refusing 0x${Number(addr).toString(16)}+${size}.`,
    { commandName: "PC_READ" }
  );
}

function formatUf2Style(value) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function readRangeFromArgs(args) {
  const bytes = args || new Uint8Array(0);
  if (bytes.length < 8) {
    throw new PicobootProtocolError("PC_READ args must include addr and size.", { commandName: "PC_READ" });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    addr: view.getUint32(0, true),
    size: view.getUint32(4, true),
  };
}

export function encodePicobootCmd({ cmdId, cmdSize, transferLength, token, args }) {
  const packet = new Uint8Array(PICOBOOT_CMD_SIZE);
  const view = new DataView(packet.buffer);
  view.setUint32(0, PICOBOOT_MAGIC, true);
  view.setUint32(4, token >>> 0, true);
  view.setUint8(8, cmdId & 0xff);
  view.setUint8(9, cmdSize & 0xff);
  view.setUint16(10, 0, true);
  view.setUint32(12, transferLength >>> 0, true);
  const argBytes = args || new Uint8Array(0);
  if (argBytes.length > 16) {
    throw new PicobootProtocolError("PICOBOOT command args exceed 16 bytes.", {
      commandName: picobootCommandName(cmdId),
    });
  }
  packet.set(argBytes, 16);
  return packet;
}

export function decodePicobootStatus(data) {
  const bytes = data instanceof DataView ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  if (bytes.length < PICOBOOT_STATUS_SIZE) {
    throw new PicobootProtocolError(`CMD_STATUS returned ${bytes.length} bytes, expected ${PICOBOOT_STATUS_SIZE}.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const statusCode = view.getUint32(4, true);
  return {
    token: view.getUint32(0, true),
    statusCode,
    statusName: picobootStatusName(statusCode),
    cmdId: view.getUint8(8),
    commandName: picobootCommandName(view.getUint8(8)),
    inProgress: view.getUint8(9) !== 0,
  };
}

function formatHexBytes(bytes) {
  return Array.from(bytes, (value) => value.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function formatRomVectorTable(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const initialSp = view.getUint32(0, true);
  const reset = view.getUint32(4, true);
  return [
    `ROM[0x00000000..0x00000010): ${formatHexBytes(bytes)}`,
    `initial SP=0x${initialSp.toString(16).toUpperCase().padStart(8, "0")}`,
    `reset=0x${reset.toString(16).toUpperCase().padStart(8, "0")}`,
  ].join("\n");
}

async function picobootReset(session) {
  const { device, transport } = requireTransport(session);
  const result = await withTimeout(
    device.controlTransferOut({
      requestType: "vendor",
      recipient: "interface",
      request: PICOBOOT_IF_RESET,
      value: 0,
      index: transport.interfaceNumber,
    }),
    CONTROL_TIMEOUT_MS,
    "PICOBOOT_IF_RESET"
  );
  if (result.status !== "ok") {
    throw new PicobootProtocolError(`PICOBOOT_IF_RESET failed (${result.status}).`, {
      commandName: "PICOBOOT_IF_RESET",
    });
  }
}

async function picobootCmdStatus(session) {
  const { device, transport } = requireTransport(session);
  const result = await withTimeout(
    device.controlTransferIn(
      {
        requestType: "vendor",
        recipient: "interface",
        request: PICOBOOT_IF_CMD_STATUS,
        value: 0,
        index: transport.interfaceNumber,
      },
      PICOBOOT_STATUS_SIZE
    ),
    CONTROL_TIMEOUT_MS,
    "PICOBOOT_IF_CMD_STATUS"
  );
  if (result.status !== "ok" || !result.data) {
    throw new PicobootProtocolError(`PICOBOOT_IF_CMD_STATUS failed (${result.status}).`, {
      commandName: "PICOBOOT_IF_CMD_STATUS",
    });
  }
  return decodePicobootStatus(result.data);
}

async function transferOutExact(device, endpointNumber, bytes, timeoutMs, label) {
  const result = await withTimeout(device.transferOut(endpointNumber, bytes), timeoutMs, label);
  if (result.status !== "ok") {
    throw new PicobootProtocolError(`${label} bulk OUT failed (${result.status}).`, {
      commandName: label,
      transferredBytes: result.bytesWritten || 0,
    });
  }
  if (bytes.byteLength > 0 && result.bytesWritten !== bytes.byteLength) {
    throw new PicobootProtocolError(
      `${label} bulk OUT wrote ${result.bytesWritten}/${bytes.byteLength} bytes.`,
      { commandName: label, transferredBytes: result.bytesWritten }
    );
  }
  return result.bytesWritten || 0;
}

async function transferInExact(device, endpointNumber, length, timeoutMs, label) {
  const result = await withTimeout(device.transferIn(endpointNumber, length), timeoutMs, label);
  if (result.status !== "ok" || !result.data) {
    throw new PicobootProtocolError(`${label} bulk IN failed (${result.status}).`, {
      commandName: label,
    });
  }
  const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
  if (bytes.length !== length) {
    throw new PicobootProtocolError(`${label} bulk IN got ${bytes.length}/${length} bytes.`, {
      commandName: label,
      transferredBytes: bytes.length,
    });
  }
  return bytes;
}

async function acknowledgeCommand(device, transport, cmdId, timeoutMs = ACK_TIMEOUT_MS) {
  // Opposite-direction zero-length ACK (picoboot.h / usb_boot_device.c _picoboot_ack).
  if (cmdId & 0x80) {
    await transferOutExact(
      device,
      transport.outEndpointNumber,
      new Uint8Array(0),
      timeoutMs,
      "PICOBOOT ACK OUT"
    );
    return;
  }
  const result = await withTimeout(
    device.transferIn(transport.inEndpointNumber, 64),
    timeoutMs,
    "PICOBOOT ACK IN"
  );
  if (result.status !== "ok") {
    throw new PicobootProtocolError(`PICOBOOT ACK IN failed (${result.status}).`, {
      commandName: picobootCommandName(cmdId),
    });
  }
  const length = result.data ? result.data.byteLength : 0;
  if (length !== 0) {
    throw new PicobootProtocolError(`PICOBOOT ACK IN expected 0 bytes, got ${length}.`, {
      commandName: picobootCommandName(cmdId),
      transferredBytes: length,
    });
  }
}

async function clearPicobootHalt(session) {
  const { device, transport } = requireTransport(session);
  try {
    await device.clearHalt("in", transport.inEndpointNumber);
  } catch (_error) {
    // Endpoint may already be idle.
  }
  try {
    await device.clearHalt("out", transport.outEndpointNumber);
  } catch (_error) {
    // Endpoint may already be idle.
  }
}

/**
 * Send one gated PICOBOOT command: 32-byte OUT, optional bulk data, ZLP ACK,
 * then vendor CMD_STATUS. The UI never calls this with an address of its own;
 * flashProgram.js supplies a Dry Run ACCEPT plan as the gate.
 */
export async function sendPicobootCommand(session, { cmdId, cmdSize, transferLength, args, data, ackTimeoutMs }, gate) {
  const range = cmdId === PC_READ || cmdId === PC_WRITE || cmdId === PC_FLASH_ERASE ? readRangeFromArgs(args) : null;
  const extra = {
    addr: range ? range.addr : undefined,
    size: range ? range.size : undefined,
    data,
    exclusiveType: cmdId === PC_EXCLUSIVE_ACCESS ? exclusiveTypeFromArgs(args) : undefined,
    reboot: cmdId === PC_REBOOT ? rebootArgsFrom(args) : undefined,
  };
  assertPicobootCommandGate(cmdId, gate, extra);

  if (cmdId === PC_READ) {
    if (transferLength !== range.size) {
      throw new PicobootProtocolError("PC_READ transferLength must match the size argument.", {
        commandName: "PC_READ",
      });
    }
  }
  if (cmdId === PC_WRITE) {
    const outData = data || new Uint8Array(0);
    if (transferLength !== range.size || outData.length !== range.size) {
      throw new PicobootProtocolError("PC_WRITE transferLength must match the size argument and payload.", {
        commandName: "PC_WRITE",
      });
    }
  }
  if (cmdId === PC_FLASH_ERASE) {
    if (transferLength) {
      throw new PicobootProtocolError("PC_FLASH_ERASE must not include a data payload.", {
        commandName: "PC_FLASH_ERASE",
      });
    }
  }
  if (cmdId === PC_EXIT_XIP) {
    if (cmdSize !== 0 || transferLength) {
      throw new PicobootProtocolError("PC_EXIT_XIP must have cmdSize 0 and no data payload.", {
        commandName: "PC_EXIT_XIP",
      });
    }
  }
  if (cmdId === PC_EXCLUSIVE_ACCESS) {
    if (cmdSize !== 1 || transferLength) {
      throw new PicobootProtocolError("PC_EXCLUSIVE_ACCESS must have cmdSize 1 and no data payload.", {
        commandName: "PC_EXCLUSIVE_ACCESS",
      });
    }
  }
  if (cmdId === PC_REBOOT) {
    if (cmdSize !== 12 || transferLength) {
      throw new PicobootProtocolError("PC_REBOOT must have cmdSize 12 and no data payload.", {
        commandName: "PC_REBOOT",
      });
    }
  }

  const { device, transport } = requireTransport(session);
  const token = allocateToken();
  const packet = encodePicobootCmd({
    cmdId,
    cmdSize,
    transferLength,
    token,
    args,
  });
  let transferredBytes = 0;
  let payload = new Uint8Array(0);
  const ackMs = ackTimeoutMs || (cmdId === PC_FLASH_ERASE ? ERASE_ACK_TIMEOUT_MS : ACK_TIMEOUT_MS);

  try {
    transferredBytes += await transferOutExact(
      device,
      transport.outEndpointNumber,
      packet,
      CMD_OUT_TIMEOUT_MS,
      `${picobootCommandName(cmdId)} command`
    );

    if (transferLength) {
      if (cmdId & 0x80) {
        payload = await transferInExact(
          device,
          transport.inEndpointNumber,
          transferLength,
          DATA_TIMEOUT_MS,
          `${picobootCommandName(cmdId)} data`
        );
        transferredBytes += payload.length;
      } else if (cmdId === PC_WRITE) {
        const outData = data || new Uint8Array(0);
        transferredBytes += await transferOutExact(
          device,
          transport.outEndpointNumber,
          outData,
          DATA_TIMEOUT_MS,
          `${picobootCommandName(cmdId)} data`
        );
      } else {
        throw new PicobootProtocolError("Bulk OUT payloads are limited to gated PC_WRITE pages.", {
          commandName: picobootCommandName(cmdId),
        });
      }
    }

    await acknowledgeCommand(device, transport, cmdId, ackMs);
  } catch (error) {
    let status;
    try {
      status = await picobootCmdStatus(session);
    } catch (_statusError) {
      status = null;
    }
    try {
      await clearPicobootHalt(session);
      await picobootReset(session);
    } catch (_resetError) {
      // Prefer the original transfer error.
    }
    if (error instanceof PicobootProtocolError) {
      error.commandName = error.commandName || picobootCommandName(cmdId);
      error.statusCode = status ? status.statusCode : error.statusCode;
      error.statusName = status ? status.statusName : error.statusName;
      error.transferredBytes = error.transferredBytes || transferredBytes;
      throw error;
    }
    throw new PicobootProtocolError(error && error.message ? error.message : String(error), {
      commandName: picobootCommandName(cmdId),
      statusCode: status ? status.statusCode : undefined,
      statusName: status ? status.statusName : undefined,
      transferredBytes,
    });
  }

  const status = await picobootCmdStatus(session);
  if (status.inProgress) {
    throw new PicobootProtocolError("PICOBOOT command still in progress after ACK.", {
      commandName: status.commandName,
      statusCode: status.statusCode,
      statusName: status.statusName,
      transferredBytes,
    });
  }
  if (status.token !== token) {
    throw new PicobootProtocolError(
      `CMD_STATUS token 0x${status.token.toString(16)} did not match command token 0x${token.toString(16)}.`,
      {
        commandName: status.commandName,
        statusCode: status.statusCode,
        statusName: status.statusName,
        transferredBytes,
      }
    );
  }
  if (status.statusCode !== PICOBOOT_OK) {
    throw new PicobootProtocolError(`PICOBOOT command failed: ${status.statusName} (${status.statusCode}).`, {
      commandName: status.commandName,
      statusCode: status.statusCode,
      statusName: status.statusName,
      transferredBytes,
      responseText: formatHexBytes(payload),
    });
  }

  return {
    commandName: picobootCommandName(cmdId),
    token,
    status,
    payload,
    transferredBytes,
  };
}

export function rangeArgs(addr, size) {
  const args = new Uint8Array(8);
  const view = new DataView(args.buffer);
  view.setUint32(0, addr >>> 0, true);
  view.setUint32(4, size >>> 0, true);
  return args;
}

export function exclusiveArgs(exclusiveType) {
  return Uint8Array.of(exclusiveType & 0xff);
}

export function rebootArgs(pc, sp, delayMs) {
  const args = new Uint8Array(12);
  const view = new DataView(args.buffer);
  view.setUint32(0, pc >>> 0, true);
  view.setUint32(4, sp >>> 0, true);
  view.setUint32(8, delayMs >>> 0, true);
  return args;
}

export async function resetPicobootInterface(session) {
  await picobootReset(session);
}

/**
 * Non-destructive PoC: RESET, then PC_READ of 16 ROM bytes at 0x00000000.
 */
export async function testPicobootCommunication(session) {
  if (session?.info?.productId === RP2350_BOOT_PID) {
    throw new PicobootProtocolError(
      "This PoC reads the RP2040 boot ROM vector table only. RP2350 is not used for the first protocol test.",
      { commandName: "PC_READ" }
    );
  }

  assertSafeRead(PICOBOOT_POC_READ_ADDR, PICOBOOT_POC_READ_SIZE);
  await picobootReset(session);

  const result = await sendPicobootCommand(
    session,
    {
      cmdId: PC_READ,
      cmdSize: 8,
      transferLength: PICOBOOT_POC_READ_SIZE,
      args: rangeArgs(PICOBOOT_POC_READ_ADDR, PICOBOOT_POC_READ_SIZE),
    },
    { kind: "rom-test" }
  );

  return {
    commandName: result.commandName,
    commandStatus: `${result.status.statusName} (${result.status.statusCode})`,
    response: formatRomVectorTable(result.payload),
    transferredBytes: String(result.payload.length),
    protocolError: "—",
    ok: true,
  };
}

/**
 * Non-destructive EEPROM probe: RESET, PC_EXIT_XIP, PC_READ 256 bytes at 0x101FF000.
 * Does not erase, write, or reboot.
 */
export async function readEepromProbe(session) {
  if (session?.info?.productId === RP2350_BOOT_PID) {
    throw new PicobootProtocolError(
      "EEPROM probe is for RP2040 MP9 only. RP2350 boot is not used.",
      { commandName: "PC_READ" }
    );
  }

  assertSafeRead(MP9_EEPROM_XIP_START, MP9_EEPROM_PROBE_SIZE);
  await picobootReset(session);

  await sendPicobootCommand(
    session,
    {
      cmdId: PC_EXIT_XIP,
      cmdSize: 0,
      transferLength: 0,
      args: new Uint8Array(0),
    },
    { kind: "eeprom-probe" }
  );

  const result = await sendPicobootCommand(
    session,
    {
      cmdId: PC_READ,
      cmdSize: 8,
      transferLength: MP9_EEPROM_PROBE_SIZE,
      args: rangeArgs(MP9_EEPROM_XIP_START, MP9_EEPROM_PROBE_SIZE),
    },
    { kind: "eeprom-probe" }
  );

  return {
    commandName: `${result.commandName} (EEPROM probe after PC_EXIT_XIP)`,
    commandStatus: `${result.status.statusName} (${result.status.statusCode})`,
    payload: result.payload,
    hex: formatHexBytes(result.payload),
    transferredBytes: String(result.payload.length),
    protocolError: "—",
    ok: true,
  };
}

export function protocolInfoFromError(error) {
  if (error instanceof PicobootProtocolError) {
    const status =
      error.statusCode === undefined || error.statusCode === null
        ? "—"
        : `${error.statusName} (${error.statusCode})`;
    return {
      commandName: error.commandName || "—",
      commandStatus: status,
      response: error.responseText || "—",
      transferredBytes: String(error.transferredBytes ?? "—"),
      protocolError: error.message,
    };
  }
  return {
    commandName: "—",
    commandStatus: "—",
    response: "—",
    transferredBytes: "—",
    protocolError: error && error.message ? error.message : String(error),
  };
}
