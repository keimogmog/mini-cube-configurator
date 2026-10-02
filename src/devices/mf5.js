import { CMD, REP, parseAck } from "../protocol.js";
import { SAVE_TIMEOUT_MS } from "../sysex.js";

export const MF5_MODEL_ID = 0x05;
export const FADER_COUNT = 5;

export const MF5_DEFAULT_CONFIG = Object.freeze({
  midiChannel: 1,
  faderCc: Object.freeze([20, 21, 22, 23, 24]),
});

export function validateMf5Config(config) {
  const channel = Number(config.midiChannel);
  if (!Number.isInteger(channel) || channel < 1 || channel > 16) {
    return "MIDI Channel must be an integer from 1 to 16.";
  }
  if (!Array.isArray(config.faderCc) || config.faderCc.length !== FADER_COUNT) {
    return "All 5 fader CC numbers are required.";
  }
  for (let i = 0; i < FADER_COUNT; i++) {
    const cc = Number(config.faderCc[i]);
    if (!Number.isInteger(cc) || cc < 0 || cc > 127) {
      return `Fader ${i + 1} CC must be an integer from 0 to 127.`;
    }
  }
  return null;
}

export function parseMf5Config(message) {
  if (!message || message.cmd !== REP.CONFIG || message.payload.length !== 1 + FADER_COUNT) {
    throw new Error("Unexpected CONFIG reply from device.");
  }
  const config = {
    midiChannel: message.payload[0],
    faderCc: message.payload.slice(1, 1 + FADER_COUNT),
  };
  const error = validateMf5Config(config);
  if (error) {
    throw new Error(`Device sent invalid config: ${error}`);
  }
  return config;
}

function encodeSetPayload(config) {
  const error = validateMf5Config(config);
  if (error) {
    throw new Error(error);
  }
  return [config.midiChannel, ...config.faderCc];
}

function renderMf5Form(root) {
  const faderFields = Array.from({ length: FADER_COUNT }, (_, i) => {
    const n = i + 1;
    const value = MF5_DEFAULT_CONFIG.faderCc[i];
    return `<label class="field"><span>Fader ${n} CC</span><input id="fader-cc-${n}" type="number" min="0" max="127" step="1" value="${value}" placeholder="${value}" disabled /></label>`;
  }).join("");

  root.innerHTML = `
    <form id="config-form" action="#" method="get">
      <label class="field">
        <span>MIDI Channel</span>
        <input id="midi-channel" name="midi-channel" type="number" min="1" max="16" step="1" value="1" disabled />
      </label>
      <fieldset>
        <legend>Faders</legend>
        ${faderFields}
      </fieldset>
    </form>
  `;

  const form = root.querySelector("#config-form");
  const channelEl = root.querySelector("#midi-channel");
  const faderInputs = Array.from({ length: FADER_COUNT }, (_, i) =>
    root.querySelector(`#fader-cc-${i + 1}`)
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
  });

  return {
    setEnabled(enabled) {
      channelEl.disabled = !enabled;
      faderInputs.forEach((input) => {
        input.disabled = !enabled;
      });
    },
    setConfig(config) {
      channelEl.value = String(config.midiChannel);
      faderInputs.forEach((input, i) => {
        input.value = String(config.faderCc[i]);
      });
    },
    getConfig() {
      return {
        midiChannel: Number(channelEl.value),
        faderCc: faderInputs.map((input) => Number(input.value)),
      };
    },
    highlightCcMatch(ccMessage) {
      if (!ccMessage) {
        return;
      }
      if (Number(channelEl.value) !== ccMessage.channel) {
        return;
      }
      faderInputs.forEach((input) => {
        if (Number(input.value) !== ccMessage.cc) {
          return;
        }
        input.classList.remove("live-midi-hit");
        void input.offsetWidth;
        input.classList.add("live-midi-hit");
      });
    },
  };
}

export const mf5Profile = {
  id: "mf5",
  modelId: MF5_MODEL_ID,
  displayName: "MF5",
  nameHints: ["mf5"],
  identify: true,
  capabilities: Object.freeze({
    configReadWrite: true,
    save: true,
    restore: true,
    enterBootloader: true,
    firmwareUpdate: true,
  }),
  firmwareManifestUrl: "./firmware/mf5/latest/manifest.json",
  defaultConfig: MF5_DEFAULT_CONFIG,
  validateConfig: validateMf5Config,
  mount(root) {
    return renderMf5Form(root);
  },
  readConfig(sysex) {
    return sysex.request({
      cmd: CMD.GET_CONFIG,
      expectedCmd: REP.CONFIG,
      parse: parseMf5Config,
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
  // Same ENTER_BOOTLOADER path as MP9; reused by Phase 3 Firmware Update.
  enterBootloader(sysex) {
    return sysex.request({
      cmd: CMD.ENTER_BOOTLOADER,
      expectedCmd: REP.ACK,
      parse: (message) => parseAck(message, CMD.ENTER_BOOTLOADER),
    });
  },
};
