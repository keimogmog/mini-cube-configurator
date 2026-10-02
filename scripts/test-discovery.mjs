import assert from "node:assert/strict";
import { MultipleMiniCubesError, discoverSupportedMiniCubes } from "../src/discovery.js";

function fakePort(id, name, state = "connected") {
  return {
    id,
    name,
    manufacturer: "mini cube",
    state,
    onmidimessage: null,
    async open() {},
  };
}

function fakeMidi(pairs) {
  const inputs = pairs.map((pair) => pair.input);
  const outputs = pairs.map((pair) => pair.output);
  const listeners = new Set();
  return {
    access: {
      inputs: { values: () => inputs.values() },
      outputs: { values: () => outputs.values() },
    },
    input: null,
    output: null,
    async bind(pair) {
      this.input = pair.input;
      this.output = pair.output;
    },
    unbindPorts() {
      this.input = null;
      this.output = null;
    },
    releaseSession() {
      this.unbindPorts();
      listeners.clear();
    },
    clearMessageListeners() {
      listeners.clear();
    },
    addMessageListener(handler) {
      listeners.add(handler);
    },
    removeMessageListener(handler) {
      listeners.delete(handler);
    },
    onDisconnected() {},
    send() {},
  };
}

{
  const err = new MultipleMiniCubesError([
    { profile: { displayName: "MF5" } },
    { profile: { displayName: "MP9" } },
  ]);
  assert.equal(err.name, "MultipleMiniCubesError");
  assert.match(err.message, /Multiple mini cube devices/);
  assert.match(err.message, /MF5/);
  assert.match(err.message, /MP9/);
  assert.equal(err.devices.length, 2);
}

{
  const midi = fakeMidi([]);
  midi.access = null;
  await assert.rejects(() => discoverSupportedMiniCubes(midi), /MIDI access is not open/);
}

{
  const midi = fakeMidi([]);
  const found = await discoverSupportedMiniCubes(midi);
  assert.deepEqual(found, []);
}

console.log("discovery auto-connect helpers passed");
