import assert from "node:assert/strict";
import {
  FIRMWARE_VERSION_RELATION,
  compareFirmwareVersions,
  parseFirmwareVersion,
} from "../src/versionCompare.js";

const { OLDER, EQUAL, NEWER, MALFORMED } = FIRMWARE_VERSION_RELATION;

function assertCompare(current, latest, expected) {
  assert.equal(
    compareFirmwareVersions(current, latest),
    expected,
    `compareFirmwareVersions(${JSON.stringify(current)}, ${JSON.stringify(latest)})`
  );
}

// Required boundary cases
assertCompare("0.3.0", "0.3.1", OLDER);
assertCompare("0.3.1", "0.3.1", EQUAL);
assertCompare("0.3.2", "0.3.1", NEWER);
assertCompare("0.9.9", "0.10.0", OLDER);
assertCompare("0.99.99", "1.0.0", OLDER);
assertCompare("9.9.9", "10.0.0", OLDER);

// Additional numeric (non-lexicographic) ordering
assertCompare("0.3.1", "0.3.0", NEWER);
assertCompare("0.4.0", "0.3.1", NEWER);
assertCompare("1.0.0", "0.99.99", NEWER);
assertCompare("10.0.0", "9.9.9", NEWER);
assertCompare("0.10.0", "0.9.9", NEWER);
assertCompare("10.20.30", "10.20.30", EQUAL);
assertCompare("10.20.29", "10.20.30", OLDER);
assertCompare("2.0.0", "10.0.0", OLDER); // string "2" > "10" lexicographically

// Zero components allowed only as exact "0"
assert.deepEqual(parseFirmwareVersion("0.0.0"), { major: 0, minor: 0, patch: 0 });
assertCompare("0.0.0", "0.0.1", OLDER);
assertCompare("0.0.1", "0.0.0", NEWER);

// Malformed: non-strings / empty
assertCompare("", "0.3.1", MALFORMED);
assertCompare("0.3.1", "", MALFORMED);
assertCompare(null, "0.3.1", MALFORMED);
assertCompare("0.3.1", null, MALFORMED);
assertCompare(undefined, "0.3.1", MALFORMED);
assertCompare("0.3.1", undefined, MALFORMED);
assertCompare(0.3, "0.3.0", MALFORMED);
assertCompare("0.3.0", 0.3, MALFORMED);
assertCompare({ major: 0, minor: 3, patch: 1 }, "0.3.1", MALFORMED);

// Malformed: prefixes / suffixes / whitespace
assertCompare("v0.3.1", "0.3.1", MALFORMED);
assertCompare("0.3.1v", "0.3.1", MALFORMED);
assertCompare("V0.3.1", "0.3.1", MALFORMED);
assertCompare(" 0.3.1", "0.3.1", MALFORMED);
assertCompare("0.3.1 ", "0.3.1", MALFORMED);
assertCompare("0.3.1\n", "0.3.1", MALFORMED);

// Malformed: wrong component counts
assertCompare("0.3", "0.3.1", MALFORMED);
assertCompare("0", "0.3.1", MALFORMED);
assertCompare("0.3.1.0", "0.3.1", MALFORMED);
assertCompare("0.3.1.2.3", "0.3.1", MALFORMED);
assertCompare(".0.3.1", "0.3.1", MALFORMED);
assertCompare("0..1", "0.3.1", MALFORMED);

// Malformed: non-numeric / ambiguous
assertCompare("0.3.x", "0.3.1", MALFORMED);
assertCompare("0.3.1-beta", "0.3.1", MALFORMED);
assertCompare("0.3.1+meta", "0.3.1", MALFORMED);
assertCompare("latest", "0.3.1", MALFORMED);
assertCompare("0.3.1", "0.3.1\0", MALFORMED);

// Malformed: leading zeros (ambiguous numeric form)
assertCompare("0.03.1", "0.3.1", MALFORMED);
assertCompare("00.3.1", "0.3.1", MALFORMED);
assertCompare("0.3.01", "0.3.1", MALFORMED);
assertCompare("01.0.0", "1.0.0", MALFORMED);

// Malformed: signs / floats / hex-looking
assertCompare("-1.0.0", "1.0.0", MALFORMED);
assertCompare("1.-2.0", "1.0.0", MALFORMED);
assertCompare("1.2.-3", "1.0.0", MALFORMED);
assertCompare("1.2.3.4", "1.2.3", MALFORMED);
assertCompare("1.2.3e0", "1.2.3", MALFORMED);
assertCompare("0x1.0.0", "1.0.0", MALFORMED);

// Fail closed when either side is bad
assertCompare("0.3.1", "0.03.1", MALFORMED);
assertCompare("bad", "also-bad", MALFORMED);

// parseFirmwareVersion unit checks
assert.equal(parseFirmwareVersion("0.3.1")?.patch, 1);
assert.equal(parseFirmwareVersion("10.20.30")?.major, 10);
assert.equal(parseFirmwareVersion("0.03.1"), null);
assert.equal(parseFirmwareVersion("v0.3.1"), null);
assert.equal(parseFirmwareVersion(""), null);
assert.equal(parseFirmwareVersion(null), null);
assert.equal(parseFirmwareVersion(undefined), null);

// Above Number.MAX_SAFE_INTEGER must reject (unsafe numeric compare)
const unsafe = `${Number.MAX_SAFE_INTEGER + 1}.0.0`;
assert.equal(parseFirmwareVersion(unsafe), null);
assertCompare(unsafe, "1.0.0", MALFORMED);

console.log("version-compare tests passed");
