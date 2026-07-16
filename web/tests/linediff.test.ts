import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRows, visibleSpans } from "../src/lib/linediff";

test("equal files produce aligned unchanged rows", () => {
  const rows = diffRows("a\nb\n", "a\nb\n");
  assert.deepEqual(rows, [
    { l: { n: 1, s: "a" }, r: { n: 1, s: "a" }, changed: false },
    { l: { n: 2, s: "b" }, r: { n: 2, s: "b" }, changed: false },
  ]);
});

test("a modified line pairs its removal with its insertion", () => {
  const rows = diffRows("a\nold\nc\n", "a\nnew\nc\n");
  assert.deepEqual(rows, [
    { l: { n: 1, s: "a" }, r: { n: 1, s: "a" }, changed: false },
    { l: { n: 2, s: "old" }, r: { n: 2, s: "new" }, changed: true },
    { l: { n: 3, s: "c" }, r: { n: 3, s: "c" }, changed: false },
  ]);
});

test("uneven change blocks fill the short side with nulls", () => {
  const rows = diffRows("a\nx\n", "a\ny\nz\n");
  assert.deepEqual(rows, [
    { l: { n: 1, s: "a" }, r: { n: 1, s: "a" }, changed: false },
    { l: { n: 2, s: "x" }, r: { n: 2, s: "y" }, changed: true },
    { l: null, r: { n: 3, s: "z" }, changed: true },
  ]);
});

test("pure insertion and pure deletion", () => {
  assert.deepEqual(diffRows("", "a\nb\n"), [
    { l: null, r: { n: 1, s: "a" }, changed: true },
    { l: null, r: { n: 2, s: "b" }, changed: true },
  ]);
  assert.deepEqual(diffRows("a\nb\n", ""), [
    { l: { n: 1, s: "a" }, r: null, changed: true },
    { l: { n: 2, s: "b" }, r: null, changed: true },
  ]);
});

test("trailing deletions flush after the loop", () => {
  const rows = diffRows("a\nb\n", "a\n");
  assert.deepEqual(rows, [
    { l: { n: 1, s: "a" }, r: { n: 1, s: "a" }, changed: false },
    { l: { n: 2, s: "b" }, r: null, changed: true },
  ]);
});

test("line numbers track each side independently", () => {
  const rows = diffRows("a\nb\nc\n", "b\nc\nd\n");
  const changed = rows.filter((r) => r.changed);
  assert.deepEqual(changed, [
    { l: { n: 1, s: "a" }, r: null, changed: true },
    { l: null, r: { n: 3, s: "d" }, changed: true },
  ]);
});

test("visibleSpans keeps context around changes and merges overlaps", () => {
  const rows = diffRows("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nX\n", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nY\n");
  // Only the last row changed; 3 rows of context above it.
  assert.deepEqual(visibleSpans(rows), [[7, 11]]);

  const twoChanges = diffRows("x\nb\nc\nd\ne\nf\ng\nh\ny\n", "X\nb\nc\nd\ne\nf\ng\nh\nY\n");
  // Changes at both ends, context 3 -> two separate spans with a gap between.
  assert.deepEqual(visibleSpans(twoChanges), [
    [0, 4],
    [5, 9],
  ]);

  // Wide context swallows the gap into one span.
  assert.deepEqual(visibleSpans(twoChanges, 5), [[0, 9]]);
});

test("visibleSpans on an unchanged diff is empty", () => {
  assert.deepEqual(visibleSpans(diffRows("a\n", "a\n")), []);
});
