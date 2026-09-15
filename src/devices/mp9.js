import { CMD, REP, parseAck } from "../protocol.js";
import { SAVE_TIMEOUT_MS } from "../sysex.js";

export const MP9_MODEL_ID = 0x09;
export const PAD_COUNT = 9;

export const MP9_DEFAULT_CONFIG = Object.freeze({
  midiChannel: 1,
  padCc: Object.freeze([30, 31, 32, 33, 34, 35, 36, 37, 38]),
});

export function validateMp9Config(config) {
  const channel = Number(config.midiChannel);
  if (!Number.isInteger(channel) || channel < 1 || channel > 16) {
    return "MIDI Channel must be an integer from 1 to 16.";
  }

  if (!Array.isArray(config.padCc) || config.padCc.length !== PAD_COUNT) {
    return "All 9 pad CC numbers are required.";
  }

  for (let i = 0; i < PAD_COUNT; i++) {
    const cc = Number(config.padCc[i]);
    if (!Number.isInteger(cc) || cc < 0 || cc > 127) {
      return `Pad ${i + 1} CC must be an integer from 0 to 127.`;
    }
  }

  return null;
}

export function parseMp9Config(message) {
  if (!message || message.cmd !== REP.CONFIG || message.payload.length !== 1 + PAD_COUNT) {
    throw new Error("Unexpected CONFIG reply from device.");
  }
  const config = {
    midiChannel: message.payload[0],
    padCc: message.payload.slice(1, 1 + PAD_COUNT),
  };
  const error = validateMp9Config(config);
  if (error) {
    throw new Error(`Device sent invalid config: ${error}`);
  }
  return config;
}

function encodeSetPayload(config) {
  const error = validateMp9Config(config);
  if (error) {
    throw new Error(error);
  }
  return [config.midiChannel, ...config.padCc];
}

function renderMp9Form(root) {
  const padFields = Array.from({ length: PAD_COUNT }, (_, i) => {
    const n = i + 1;
    const value = MP9_DEFAULT_CONFIG.padCc[i];
    return `<label class="field"><span>Pad ${n} CC</span><input id="pad-cc-${n}" type="number" min="0" max="127" step="1" value="${value}" placeholder="${value}" disabled /></label>`;
  }).join("");

  root.innerHTML = `
    <form id="config-form" action="#" method="get">
      <label class="field">
        <span>MIDI Channel</span>
        <input id="midi-channel" name="midi-channel" type="number" min="1" max="16" step="1" value="1" disabled />
      </label>
      <fieldset>
        <legend>Pads</legend>
        ${padFields}
      </fieldset>
    </form>
  `;

  const form = root.querySelector("#config-form");
  const channelEl = root.querySelector("#midi-channel");
  const padInputs = Array.from({ length: PAD_COUNT }, (_, i) => root.querySelector(`#pad-cc-${i + 1}`));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
  });

  return {
    setEnabled(enabled) {
      channelEl.disabled = !enabled;
      padInputs.forEach((input) => {
        input.disabled = !enabled;
      });
    },
    setConfig(config) {
      channelEl.value = String(config.midiChannel);
      padInputs.forEach((input, i) => {
        input.value = String(config.padCc[i]);
      });
    },
    getConfig() {
      return {
        midiChannel: Number(channelEl.value),
        padCc: padInputs.map((input) => Number(input.value)),
      };
    },
  };
}

export const mp9Profile = {
  id: "mp9",
  modelId: MP9_MODEL_ID,
  displayName: "MP9",
  nameHints: ["mp9"],
  identify: true,
  capabilities: Object.freeze({
    configReadWrite: true,
    save: true,
    restore: true,
    firmwareUpdate: true,
  }),
  defaultConfig: MP9_DEFAULT_CONFIG,
  validateConfig: validateMp9Config,
  mount(root) {
    return renderMp9Form(root);
  },
  readConfig(sysex) {
    return sysex.request({
      cmd: CMD.GET_CONFIG,
      expectedCmd: REP.CONFIG,
      parse: parseMp9Config,
    });
  },
  writeConfig(sysex, config) {
    const payload = encodeSetPayload(config);
    return sysex.request({
      cmd: CMD.SET_CONFIG,
      payload,
      expectedCmd: REP.ACK,
      parse: (message) => parseAck(message, CMD.SET_CONFIG),
    });
  },
  saveConfig(sysex) {
    return sysex.request({
      cmd: CMD.SAVE_CONFIG,
      expectedCmd: REP.ACK,
      parse: (message) => parseAck(message, CMD.SAVE_CONFIG),
      timeoutMs: SAVE_TIMEOUT_MS,
    });
  },
  restoreDefaults(sysex) {
    return sysex.request({
      cmd: CMD.RESTORE_DEFAULTS,
      expectedCmd: REP.ACK,
      parse: (message) => parseAck(message, CMD.RESTORE_DEFAULTS),
      timeoutMs: SAVE_TIMEOUT_MS,
    });
  },
  enterBootloader(sysex) {
    return sysex.request({
      cmd: CMD.ENTER_BOOTLOADER,
      expectedCmd: REP.ACK,
      parse: (message) => parseAck(message, CMD.ENTER_BOOTLOADER),
    });
  },
};
