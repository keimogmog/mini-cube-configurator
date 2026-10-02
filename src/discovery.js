import { listPortPairs, MidiConnection, portLabel } from "./midi.js";
import { getProfileByModelId, listProfiles, profilesMatchingPort } from "./devices/registry.js";
import { SysexTransport } from "./sysex.js";

export class MultipleMiniCubesError extends Error {
  constructor(devices) {
    const names = devices.map((device) => device.profile.displayName).join(", ");
    super(
      `Multiple mini cube devices are connected (${names}). Press Connect to choose one, or leave only one device plugged in.`
    );
    this.name = "MultipleMiniCubesError";
    this.devices = devices;
  }
}

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

function pairKey(pair) {
  return `${pair.input.id}::${pair.output.id}`;
}

/**
 * Probe every MIDI in/out pair with GET_INFO. Name hints only affect order.
 * Leaves `midi` unbound when finished.
 * @returns {Promise<Array<{ pair: object, profile: object, info: object }>>}
 */
export async function discoverSupportedMiniCubes(midi) {
  if (!midi?.access) {
    throw new Error("MIDI access is not open.");
  }

  const pairs = rankPairs(listPortPairs(midi.access));
  if (pairs.length === 0) {
    return [];
  }

  midi.releaseSession();
  const sysex = new SysexTransport(midi);
  const found = [];
  const seenPairs = new Set();

  for (const pair of pairs) {
    const key = pairKey(pair);
    if (seenPairs.has(key)) {
      continue;
    }
    seenPairs.add(key);

    await midi.bind(pair);
    let matched = null;
    for (const profile of rankProfilesForPair(pair)) {
      try {
        const info = await sysex.getInfo(profile.modelId);
        const identified = getProfileByModelId(info.modelId);
        if (!identified || identified.modelId !== profile.modelId) {
          throw new Error("GET_INFO model did not match the probed device profile.");
        }
        matched = {
          pair,
          profile: identified,
          info: {
            ...info,
            model: identified.displayName,
          },
        };
        break;
      } catch {
        // Try the next profile / pair.
      }
    }
    midi.unbindPorts();
    if (matched) {
      found.push(matched);
    }
  }

  midi.clearMessageListeners();
  return found;
}

/**
 * Bind an already-discovered candidate and return a live session object.
 */
export async function openMiniCubeSession(midi, candidate, { onDisconnected } = {}) {
  if (!candidate?.pair || !candidate?.profile || !candidate?.info) {
    throw new Error("No mini cube candidate to open.");
  }

  midi.releaseSession();
  const sysex = new SysexTransport(midi);
  midi.onDisconnected(() => {
    sysex.rejectPending(new Error("Device disconnected."));
    midi.releaseSession();
    if (onDisconnected) {
      onDisconnected();
    }
  });

  await midi.bind(candidate.pair);
  sysex.lockModel(candidate.info.modelId);
  return {
    midi,
    sysex,
    profile: candidate.profile,
    info: candidate.info,
  };
}

/**
 * Open Web MIDI (or reuse `midi` with access) and connect a supported device.
 *
 * @param {object} [options]
 * @param {() => void} [options.onDisconnected]
 * @param {boolean} [options.requireUnique] If true, refuse when more than one
 *   supported mini cube answers GET_INFO (auto-connect path).
 * @param {MidiConnection} [options.midi] Reuse an access-holding connection.
 */
export async function connectMiniCube({ onDisconnected, requireUnique = false, midi } = {}) {
  const owned = !midi;
  const connection = midi || new MidiConnection();

  if (!connection.access) {
    await connection.requestAccess();
  }

  let found;
  try {
    found = await discoverSupportedMiniCubes(connection);
  } catch (error) {
    if (owned) {
      connection.close();
    } else {
      connection.releaseSession();
    }
    throw error;
  }

  if (found.length === 0) {
    if (owned) {
      connection.close();
    } else {
      connection.releaseSession();
    }
    throw new Error(
      "No supported mini cube device responded to GET_INFO. Connect MP9 or MF5 and try again."
    );
  }

  if (requireUnique && found.length > 1) {
    if (owned) {
      connection.close();
    } else {
      connection.releaseSession();
    }
    throw new MultipleMiniCubesError(found);
  }

  return openMiniCubeSession(connection, found[0], { onDisconnected });
}
