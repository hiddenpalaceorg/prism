import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRange } from "../src/lib/range";

test("parseRange: no header or empty file serves the whole thing (null)", () => {
  assert.equal(parseRange(null, 1000), null);
  assert.equal(parseRange("bytes=0-99", 0), null);
  assert.equal(parseRange("bytes=-", 1000), null); // both ends empty
});

test("parseRange: explicit start/end is clamped to the file", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=100-", 1000), { start: 100, end: 999 });
  assert.deepEqual(parseRange("bytes=500-100000", 1000), { start: 500, end: 999 });
});

test("parseRange: suffix range counts back from the end and can't underflow", () => {
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
});

test("parseRange: unsatisfiable or malformed ranges are null", () => {
  assert.equal(parseRange("bytes=2000-3000", 1000), null); // start past EOF
  assert.equal(parseRange("bytes=5-3", 1000), null); // start > end
  assert.equal(parseRange("bytes=abc", 1000), null); // not digits
  assert.equal(parseRange("0-99", 1000), null); // missing unit
});
