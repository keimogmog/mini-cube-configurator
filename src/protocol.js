export const SYSEX_START = 0xf0;
export const SYSEX_END = 0xf7;
export const SX_MFR = 0x7d;
export const SX_FAM0 = 0x4d; // 'M'
export const SX_FAM1 = 0x43; // 'C'

export const CMD = Object.freeze({
  GET_INFO: 0x01,
  GET_CONFIG: 0x02,
  SET_CONFIG: 0x03,
  SAVE_CONFIG: 0x04,
  RESTORE_DEFAULTS: 0x05,
  ENTER_BOOTLOADER: 0x06,
});

export const REP = Object.freeze({
  INFO: 0x11,
  CONFIG: 0x12,
  ACK: 0x13,
  NACK: 0x14,
});

export const NACK_REASON = Object.freeze({
  0x01: "unknown command",
  0x02: "bad length",
  0x03: "invalid value",
  0x04: "save failed",
});

export function encodeCommand(modelId, cmd, payload = []) {
  return Uint8Array.from([
    SYSEX_START,
    SX_MFR,
    SX_FAM0,
    SX_FAM1,
    modelId,
    cmd,
    ...payload,
    SYSEX_END,
  ]);
}

function toBytes(data) {
  return Array.from(data);
}

export function parseFamilySysEx(data) {
  const bytes = toBytes(data);
  if (bytes.length < 7) {
    return null;
  }
  if (bytes[0] !== SYSEX_START || bytes[bytes.length - 1] !== SYSEX_END) {
    return null;
  }
  if (bytes[1] !== SX_MFR || bytes[2] !== SX_FAM0 || bytes[3] !== SX_FAM1) {
    return null;
  }

  return {
    modelId: bytes[4],
    cmd: bytes[5],
    payload: bytes.slice(6, -1),
  };
}

export function parseInfo(message) {
  if (!message || message.cmd !== REP.INFO || message.payload.length !== 4) {
    throw new Error("Unexpected INFO reply from device.");
  }
  const [major, minor, patch, configVersion] = message.payload;
  return {
    family: "mini cube",
    modelId: message.modelId,
    firmware: `${major}.${minor}.${patch}`,
    configVersion,
  };
}

export function parseAck(message, expectedCmd) {
  if (!message || message.cmd !== REP.ACK || message.payload.length !== 1) {
    throw new Error("Unexpected ACK from device.");
  }
  if (message.payload[0] !== expectedCmd) {
    throw new Error("ACK did not match the command that was sent.");
  }
}

export function nackError(message) {
  const cmd = message.payload[0];
  const reason = message.payload[1];
  const reasonText = NACK_REASON[reason] || `reason ${reason}`;
  return new Error(`Device rejected command 0x${Number(cmd).toString(16)} (${reasonText}).`);
}
