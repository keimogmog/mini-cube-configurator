import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(path.join(root, "index.html"), "utf8");

const legacyOpen = html.match(
  /<section\b[^>]*\bid="legacy-bootloader-panel"[^>]*>/
);
assert.ok(legacyOpen, "legacy-bootloader-panel section must exist");
assert.match(
  legacyOpen[0],
  /\bhidden\b/,
  "legacy Bootloader / debug panel must be hidden from normal UI"
);
assert.match(legacyOpen[0], /\baria-hidden="true"/);

const fwOpen = html.match(
  /<section\b[^>]*\bclass="[^"]*\bfw-update-panel\b[^"]*"[^>]*>/
);
assert.ok(fwOpen, "fw-update-panel section must exist");
assert.doesNotMatch(
  fwOpen[0],
  /\bhidden\b/,
  "guided Firmware Update panel must be visible in normal UI"
);

assert.match(html, /id="fw-update-heading"/);
assert.match(html, />Firmware Update</);
assert.match(html, /id="fw-connect-bootloader-btn"/);
assert.match(
  html,
  /id="fw-connect-bootloader-btn"[^>]*\bhidden\b/,
  "Continue stays hidden until waiting-for-bootloader phase"
);
assert.match(html, />\s*Continue\s*</);

const topFirmwareUpdate = html.match(/<button\b[^>]*\bid="firmware-update-btn"[^>]*>/);
assert.ok(topFirmwareUpdate, "top firmware-update-btn remains in DOM for wiring");
assert.match(
  topFirmwareUpdate[0],
  /\bhidden\b/,
  "top Firmware Update ENTER_BOOTLOADER control is hidden from normal UI"
);

const enterBootloader = html.match(/<button\b[^>]*\bid="enter-bootloader-btn"[^>]*>/);
assert.ok(enterBootloader, "enter-bootloader-btn remains in DOM for wiring");
assert.match(
  enterBootloader[0],
  /\bhidden\b/,
  "Enter Bootloader stays hidden until a connected profile enables enterBootloader without firmwareUpdate"
);

const checkAgain = html.match(/<button\b[^>]*\bid="check-firmware-btn"[^>]*>/);
assert.ok(checkAgain);
assert.match(checkAgain[0], /\bhidden\b/);
assert.match(html, />\s*Try again\s*</);

assert.match(html, /id="fw-update-manual-bootsel"/);
assert.match(
  html,
  /id="fw-update-manual-bootsel"[^>]*\bhidden\b/,
  "manual BOOTSEL instructions stay hidden until legacy waiting phase"
);

const hint = html.match(/<p class="hint">(.*?)<\/p>/s);
assert.ok(hint, "product intro hint must exist");
for (const banned of ["PoC", "Dry Run", "WebUSB", "SysEx", "PICOBOOT"]) {
  assert.equal(
    hint[1].includes(banned),
    false,
    `intro hint must not contain ${banned}`
  );
}
assert.match(
  hint[1],
  /configure MIDI controls and update firmware/i,
  "intro hint should describe product purpose"
);

console.log("public-ui-surface tests passed");
