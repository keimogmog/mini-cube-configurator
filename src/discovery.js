import { listPortPairs, MidiConnection, portLabel } from "./midi.js";
import { getProfileByModelId, listProfiles, profilesMatchingPort } from "./devices/registry.js";
import { SysexTransport } from "./sysex.js";

function rankProfilesForPair(pair) {
  const hinted = profilesMatchingPort(pairLabel(pair));
  const hintedIds = new Set(hinted.map((profile) => profile.id));
  const rest = listProfiles().filter((profile) => profile.identify && !hintedIds.has(profile.id));
  return [...hinted.filter((profile) => profile.identify), ...rest];
}

function pairLabel(pair) {
  return `${portLabel(pair.input)} ${portLabel(pair.output)}`;
}

function isHintedIdentifiable(pair) {
  return profilesMatchingPort(pairLabel(pair)).some((profile) => profile.identify);
}

function rankPairs(pairs) {
  return [...pairs].sort((a, b) => Number(isHintedIdentifiable(b)) - Number(isHintedIdentifiable(a)));
}

export async function connectMiniCube({ onDisconnected } = {}) {
  const midi = new MidiConnection();
  const access = await midi.requestAccess();
  const pairs = rankPairs(listPortPairs(access));
  if (pairs.length === 0) {
    midi.close();
    throw new Error("No MIDI input/output pair was found.");
  }

  const hintedPairs = pairs.filter(isHintedIdentifiable);
  if (hintedPairs.length === 0) {
    midi.close();
    throw new Error(
      'No mini cube MIDI port found. Connect a device and wait until the USB product name contains a known model such as "MP9".'
    );
  }
  const tryPairs = hintedPairs;

  const sysex = new SysexTransport(midi);
  midi.onDisconnected(() => {
    sysex.rejectPending(new Error("Device disconnected."));
    if (onDisconnected) {
      onDisconnected();
    }
  });

  let lastError = null;
  for (const pair of tryPairs) {
    await midi.bind(pair);
    const profiles = rankProfilesForPair(pair);
    for (const profile of profiles) {
      try {
        const info = await sysex.getInfo(profile.modelId);
        const identified = getProfileByModelId(info.modelId);
        if (!identified || identified.modelId !== profile.modelId) {
          throw new Error("GET_INFO model did not match the probed device profile.");
        }
        sysex.lockModel(info.modelId);
        return {
          midi,
          sysex,
          profile: identified,
          info: {
            ...info,
            model: identified.displayName,
          },
        };
      } catch (error) {
        lastError = error;
      }
    }
    midi.unbindPorts();
  }

  midi.close();
  const detail = lastError && lastError.message ? ` Last error: ${lastError.message}` : "";
  throw new Error(
    `No supported mini cube device responded to GET_INFO. Connect a device such as MP9 and wait until the USB name is visible.${detail}`
  );
}
