import { test } from "node:test";
import assert from "node:assert/strict";
import { blameHunks, blameLines } from "../src/lib/blame";

test("a single version blames every line on itself", () => {
  assert.deepEqual(blameLines(["a\nb\nc\n"]), [0, 0, 0]);
});

test("unchanged lines keep their original blame", () => {
  assert.deepEqual(blameLines(["a\nb\nc\n", "a\nB\nc\n"]), [0, 1, 0]);
});

test("an insertion blames only the new lines", () => {
  assert.deepEqual(blameLines(["a\nc\n", "a\nb\nc\n"]), [0, 1, 0]);
});

test("a deletion shifts blame without reassigning it", () => {
  assert.deepEqual(blameLines(["a\nb\nc\n", "a\nc\n"]), [0, 0]);
});

test("blame survives multiple revisions", () => {
  // v0 writes a..c, v1 rewrites b, v2 appends d.
  assert.deepEqual(blameLines(["a\nb\nc\n", "a\nB\nc\n", "a\nB\nc\nd\n"]), [0, 1, 0, 2]);
});

test("delete then re-add attributes every line to the re-add", () => {
  assert.deepEqual(blameLines(["x\ny\n", "", "x\ny\n"]), [2, 2]);
});

test("empty inputs", () => {
  assert.deepEqual(blameLines([]), []);
  assert.deepEqual(blameLines([""]), []);
});

test("a final line without trailing newline still counts", () => {
  assert.deepEqual(blameLines(["a\nb"]), [0, 0]);
});

test("blameHunks groups consecutive lines from the same commit", () => {
  assert.deepEqual(blameHunks([0, 0, 1, 1, 1, 0]), [
    { commit: 0, start: 0, len: 2 },
    { commit: 1, start: 2, len: 3 },
    { commit: 0, start: 5, len: 1 },
  ]);
  assert.deepEqual(blameHunks([]), []);
});
