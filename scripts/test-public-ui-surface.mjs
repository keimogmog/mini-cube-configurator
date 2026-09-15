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

assert.match(html, /id="fw-update-heading"/);
assert.match(html, />Firmware Update</);
assert.match(html, /id="fw-connect-bootloader-btn"/);
assert.match(
  html,
  /id="fw-connect-bootloader-btn"[^>]*\bhidden\b/,
  "Connect to Bootloader stays hidden until waiting-for-bootloader phase"
);

const topFirmwareUpdate = html.match(/<button\b[^>]*\bid="firmware-update-btn"[^>]*>/);
assert.ok(topFirmwareUpdate, "top firmware-update-btn remains in DOM for wiring");
assert.match(
  topFirmwareUpdate[0],
  /\bhidden\b/,
  "top Firmware Update ENTER_BOOTLOADER control is hidden from normal UI"
);

const checkAgain = html.match(/<button\b[^>]*\bid="check-firmware-btn"[^>]*>/);
assert.ok(checkAgain);
assert.match(checkAgain[0], /\bhidden\b/);
assert.match(html, />\s*Check again\s*</);

assert.match(html, /id="fw-update-manual-bootsel"/);
assert.match(
  html,
  /id="fw-update-manual-bootsel"[^>]*\bhidden\b/,
  "manual BOOTSEL instructions stay hidden until legacy waiting phase"
);

console.log("public-ui-surface tests passed");
