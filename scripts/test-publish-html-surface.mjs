/**
 * Asserts the public publish assemble surface without running the full workflow.
 * Mirrors .github/workflows/publish-configurator.yml UI guards after rsync
 * (no HTML transform — source index.html is what Pages ships).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(path.join(root, "index.html"), "utf8");

assert.match(
  html,
  /id="restore-btn" type="button" disabled>Restore defaults<\/button>/
);
assert.doesNotMatch(html, /id="restore-btn"[^>]*\bhidden\b/);

const fw = html.match(
  /<section\b[^>]*\bclass="[^"]*\bfw-update-panel\b[^"]*"[^>]*>/
);
assert.ok(fw, "fw-update-panel section missing");
assert.doesNotMatch(fw[0], /\bhidden\b/, "guided Firmware Update must publish visible");

const legacy = html.match(
  /<section\b[^>]*\bid="legacy-bootloader-panel"[^>]*>/
);
assert.ok(legacy, "legacy-bootloader-panel section missing");
assert.match(legacy[0], /\bhidden\b/, "legacy PoC panel must stay hidden on publish");

const hint = html.match(/<p class="hint">(.*?)<\/p>/s);
assert.ok(hint, "product intro hint missing");
for (const banned of ["PoC", "Dry Run", "WebUSB", "SysEx", "PICOBOOT"]) {
  assert.equal(hint[1].includes(banned), false, `intro must not contain ${banned}`);
}

assert.doesNotMatch(html, /id="public-cc-only-style"/);
assert.doesNotMatch(html, /:has\(#midi-channel\)/);

console.log("publish-html-surface tests passed");
