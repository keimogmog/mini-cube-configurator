import assert from "node:assert/strict";
import { MidiConnection } from "../src/midi.js";

{
  const midi = new MidiConnection();
  let disconnected = 0;
  let portEvents = 0;
  midi.onDisconnected(() => {
    disconnected += 1;
  });
  midi.onPortStateChange(() => {
    portEvents += 1;
  });

  midi.access = {
    onstatechange: null,
  };
  midi.access.onstatechange = midi._handleStateChange.bind(midi);

  const input = { id: "in-1", onmidimessage: null };
  const output = { id: "out-1" };
  midi.input = input;
  midi.output = output;
  midi.addMessageListener(() => {});

  midi.access.onstatechange({ port: { id: "in-1", state: "disconnected" } });
  assert.equal(disconnected, 1);
  assert.equal(portEvents, 1);
  assert.equal(midi.input, null);
  assert.equal(midi.output, null);
  assert.ok(midi.access, "access stays open after bound-port disconnect");

  midi.access.onstatechange({ port: { id: "in-2", state: "connected" } });
  assert.equal(portEvents, 2);
  assert.equal(disconnected, 1);

  midi.close();
  assert.equal(midi.access, null);
}

console.log("midi access watch helpers passed");
