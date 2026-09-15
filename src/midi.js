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

export class MidiConnection {
  constructor() {
    this.access = null;
    this.input = null;
    this.output = null;
    this._onMessage = null;
    this._onDisconnected = null;
    this._handleStateChange = this._handleStateChange.bind(this);
    this._handleMidiMessage = this._handleMidiMessage.bind(this);
  }

  onMessage(handler) {
    this._onMessage = handler;
  }

  onDisconnected(handler) {
    this._onDisconnected = handler;
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

  close() {
    this.unbindPorts();
    if (this.access) {
      this.access.onstatechange = null;
    }
    this.access = null;
  }

  _handleMidiMessage(event) {
    if (this._onMessage) {
      this._onMessage(event.data);
    }
  }

  _handleStateChange(event) {
    const port = event.port;
    if (!port || port.state === "connected") {
      return;
    }
    const currentIds = [this.input?.id, this.output?.id];
    if (!currentIds.includes(port.id)) {
      return;
    }

    const handler = this._onDisconnected;
    this.close();
    if (handler) {
      handler();
    }
  }
}
