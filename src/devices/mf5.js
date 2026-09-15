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

function renderMf5Placeholder(root) {
  const faderFields = Array.from({ length: FADER_COUNT }, (_, i) => {
    const n = i + 1;
    const value = MF5_DEFAULT_CONFIG.faderCc[i];
    return `<label class="field"><span>Fader ${n} CC</span><input type="number" min="0" max="127" step="1" value="${value}" disabled /></label>`;
  }).join("");

  root.innerHTML = `
    <div class="placeholder-panel">
      <p class="hint">
        MF5 is reserved here as a future 5-fader mini cube device.
        There is no Configurator firmware or SysEx protocol for MF5 yet, so this panel is a layout stub only.
      </p>
      <form action="#" method="get">
        <label class="field">
          <span>MIDI Channel</span>
          <input type="number" min="1" max="16" step="1" value="1" disabled />
        </label>
        <fieldset>
          <legend>Faders</legend>
          ${faderFields}
        </fieldset>
      </form>
    </div>
  `;

  return {
    setEnabled() {},
    setConfig() {},
    getConfig() {
      return { ...MF5_DEFAULT_CONFIG, faderCc: [...MF5_DEFAULT_CONFIG.faderCc] };
    },
  };
}

export const mf5Profile = {
  id: "mf5",
  modelId: MF5_MODEL_ID,
  displayName: "MF5",
  nameHints: ["mf5"],
  identify: false,
  capabilities: Object.freeze({
    configReadWrite: false,
    save: false,
    restore: false,
  }),
  defaultConfig: MF5_DEFAULT_CONFIG,
  validateConfig: validateMf5Config,
  mount(root) {
    return renderMf5Placeholder(root);
  },
};
