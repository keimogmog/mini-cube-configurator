export function portLabel(port) {
  return `${port.name || ""} ${port.manufacturer || ""}`.toLowerCase();
}

export function listPortPairs(access) {
  const outputs = Array.from(access.outputs.values());
  const usedOutputs = new Set();
  const pairs = [];

  for (const input of access.inputs.values()) {
    const output =
      outputs.find((candidate) => !usedOutputs.has(candidate.id) && candidate.name === input.name) ||
      outputs.find((candidate) => !usedOutputs.has(candidate.id) && portLabel(candidate) === portLabel(input));
    if (!output) {
      continue;
    }
    usedOutputs.add(output.id);
    pairs.push({ input, output });
  }

  return pairs;
}

/** Control Change only: status 0xB0–0xBF. */
export function parseControlChange(data) {
  if (!data || data.length < 3) {
    return null;
  }
  const status = data[0];
  if (status < 0xb0 || status > 0xbf) {
    return null;
  }
  return {
    channel: (status & 0x0f) + 1,
    cc: data[1] & 0x7f,
    value: data[2] & 0x7f,
  };
}

export function formatLiveMidi(ccMessage) {
  if (!ccMessage) {
    return "—";
  }
  return `CH ${ccMessage.channel} / CC ${ccMessage.cc} / Value ${ccMessage.value}`;
}

/**
 * Best-effort MIDI/SysEx permission probe. Browsers that lack Permissions API
 * return "unknown" — callers may still try requestMIDIAccess when appropriate.
 * @returns {Promise<"granted"|"denied"|"prompt"|"unknown">}
 */
export async function midiSysexPermissionState() {
  if (!navigator.permissions || typeof navigator.permissions.query !== "function") {
    return "unknown";
  }
  try {
    const status = await navigator.permissions.query({ name: "midi", sysex: true });
    return status.state;
  } catch {
    try {
      const status = await navigator.permissions.query({ name: "midi" });
      return status.state;
    } catch {
      return "unknown";
    }
  }
}

export class MidiConnection {
  constructor() {
    this.access = null;
    this.input = null;
    this.output = null;
    this._messageListeners = new Set();
    this._onDisconnected = null;
    this._onPortStateChange = null;
    this._handleStateChange = this._handleStateChange.bind(this);
    this._handleMidiMessage = this._handleMidiMessage.bind(this);
  }

  addMessageListener(handler) {
    if (typeof handler !== "function") {
      throw new Error("MIDI message listener must be a function.");
    }
    this._messageListeners.add(handler);
  }

  removeMessageListener(handler) {
    this._messageListeners.delete(handler);
  }

  clearMessageListeners() {
    this._messageListeners.clear();
  }

  onDisconnected(handler) {
    this._onDisconnected = handler;
  }

  /** Fires for any MIDIAccess statechange while access is open. */
  onPortStateChange(handler) {
    this._onPortStateChange = handler;
  }

  async requestAccess() {
    if (!navigator.requestMIDIAccess) {
      throw new Error("Web MIDI is not available. Use Chrome or Edge on desktop.");
    }

    const access = await navigator.requestMIDIAccess({ sysex: true });
    if (!access.sysexEnabled) {
      throw new Error("SysEx permission is required to read and write device settings.");
    }

    this.access = access;
    this.access.onstatechange = this._handleStateChange;
    return access;
  }

  async bind(pair) {
    this.input = pair.input;
    this.output = pair.output;
    this.input.onmidimessage = this._handleMidiMessage;
    await this.input.open();
    await this.output.open();
  }

  send(bytes) {
    if (!this.output) {
      throw new Error("No MIDI output is bound.");
    }
    this.output.send(bytes);
  }

  unbindPorts() {
    if (this.input) {
      this.input.onmidimessage = null;
    }
    this.input = null;
    this.output = null;
  }

  /**
   * Keep MIDIAccess open for replug detection. Clears bound ports and message
   * listeners; does not clear onDisconnected / onPortStateChange watchers.
   */
  releaseSession() {
    this.unbindPorts();
    this.clearMessageListeners();
  }

  close() {
    this.releaseSession();
    this._onDisconnected = null;
    this._onPortStateChange = null;
    if (this.access) {
      this.access.onstatechange = null;
    }
    this.access = null;
  }

  _handleMidiMessage(event) {
    const data = event.data;
    for (const handler of this._messageListeners) {
      handler(data);
    }
  }

  _handleStateChange(event) {
    const port = event.port;
    if (port && port.state !== "connected") {
      const currentIds = [this.input?.id, this.output?.id];
      if (currentIds.includes(port.id)) {
        const handler = this._onDisconnected;
        this.releaseSession();
        if (handler) {
          handler();
        }
      }
    }
    if (this._onPortStateChange) {
      this._onPortStateChange(event);
    }
  }
}
