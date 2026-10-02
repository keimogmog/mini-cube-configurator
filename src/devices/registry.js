import { mf5Profile } from "./mf5.js";
import { mp9Profile } from "./mp9.js";

const profiles = [mp9Profile, mf5Profile];

export function listProfiles() {
  return profiles;
}

export function getProfileById(id) {
  return profiles.find((profile) => profile.id === id) || null;
}

export function getProfileByModelId(modelId) {
  return profiles.find((profile) => profile.modelId === modelId) || null;
}

export function profilesMatchingPort(label) {
  const normalized = label.toLowerCase();
  return profiles.filter((profile) =>
    profile.nameHints.some((hint) => normalized.includes(hint))
  );
}
