import {
  CMD,
  REP,
  encodeCommand,
  nackError,
  parseFamilySysEx,
  parseInfo,
} from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 1000;
const SAVE_TIMEOUT_MS = 2000;

export { DEFAULT_TIMEOUT_MS, SAVE_TIMEOUT_MS };

export class SysexTransport {
  constructor(midi) {
    this.midi = midi;
    this.modelId = null;
    this._pending = null;
    midi.onMessage((data) => this._handleMessage(data));
  }

  lockModel(modelId) {
    this.modelId = modelId;
  }

  getInfo(modelId = this.modelId) {
    return this.request({
      modelId,
      cmd: CMD.GET_INFO,
      expectedCmd: REP.INFO,
      parse: parseInfo,
    });
  }

  request({
    modelId = this.modelId,
    cmd,
    payload = [],
    expectedCmd,
    parse,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    if (modelId == null) {
      return Promise.reject(new Error("No device model is selected for SysEx."));
    }
    if (!this.midi.output || !this.midi.input) {
      return Promise.reject(new Error("Device is not connected."));
    }
    if (this._pending) {
      return Promise.reject(new Error("Another configuration request is already in progress."));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending = null;
        reject(new Error("Timed out waiting for the device. Is configurator firmware loaded?"));
      }, timeoutMs);

      this._pending = {
        modelId,
        expectedCmd,
        parse,
        resolve: (value) => {
          clearTimeout(timer);
          this._pending = null;
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this._pending = null;
          reject(error);
        },
      };

      try {
        this.midi.send(encodeCommand(modelId, cmd, payload));
      } catch (error) {
        this._pending.reject(error);
      }
    });
  }

  rejectPending(error) {
    if (this._pending) {
      this._pending.reject(error);
      this._pending = null;
    }
  }

  _handleMessage(data) {
    const message = parseFamilySysEx(data);
    if (!message || !this._pending) {
      return;
    }
    if (message.modelId !== this._pending.modelId) {
      return;
    }

    if (message.cmd === REP.NACK) {
      this._pending.reject(nackError(message));
      return;
    }

    if (message.cmd !== this._pending.expectedCmd) {
      return;
    }

    try {
      this._pending.resolve(this._pending.parse(message));
    } catch (error) {
      this._pending.reject(error);
    }
  }
}
