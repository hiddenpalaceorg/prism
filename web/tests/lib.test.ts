import { test } from "node:test";
import assert from "node:assert/strict";
import { tlshDiff } from "../src/lib/tlsh";
import { hexToId63, toSigned64, lshBands, setJaccard, minhashJaccard } from "../src/lib/fingerprint";

// Real fixtures generated with py-tlsh (the reference implementation) — this pins the
// pure-JS tlshDiff to the canonical distances.
const DA = "T19481953E00A63DF7D144A14C92F36575FB30450AEF5C77D0115B447D4D14C55043D217";
const DB = "T19E818F3E00AA3DF7E184A19C96F365B5FB30590AEF9C77D0129B44BD8D19C59083E21B";
const DC = "T1E1812B005919746DA41CD2D982AEE882CD6B0D28641696865312A2AC30E710CCA0C5B8";

test("tlshDiff matches py-tlsh reference distances", () => {
  assert.equal(tlshDiff(DA, DA), 0);
  assert.equal(tlshDiff(DA, DB), 82);
  assert.equal(tlshDiff(DA, DC), 341);
  assert.equal(tlshDiff(DB, DC), 298);
  // symmetric
  assert.equal(tlshDiff(DB, DA), tlshDiff(DA, DB));
});

test("tlshDiff returns null on malformed digests", () => {
  assert.equal(tlshDiff("nope", DA), null);
});

test("hexToId63 takes the first 8 bytes, masked to 63 bits", () => {
  assert.equal(hexToId63("0000000000000010ffffffffffffffff"), 16n);
  assert.equal(hexToId63("ffffffffffffffff"), (1n << 63n) - 1n); // top bit masked off
  assert.equal(hexToId63(null), null);
  assert.equal(hexToId63(""), null);
});

test("toSigned64 reinterprets the u64 bit pattern", () => {
  assert.equal(toSigned64(0xffffffffffffffffn), -1n);
  assert.equal(toSigned64(0n), 0n);
});

test("lshBands folds a 128-slot signature into 16 deterministic bands", () => {
  const sig = Array.from({ length: 128 }, (_, i) => BigInt(i * 2654435761));
  const a = lshBands(sig);
  const b = lshBands(sig);
  assert.equal(a.length, 16);
  assert.deepEqual(a, b); // deterministic
  // a different signature yields different bands
  const sig2 = sig.slice();
  sig2[0] = 999999n;
  assert.notDeepEqual(lshBands(sig2), a);
});

test("setJaccard = intersection / union", () => {
  assert.equal(setJaccard([1, 2, 3], [2, 3, 4]), 0.5); // 2 / 4
  assert.equal(setJaccard([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(setJaccard([1, 2], [3, 4]), 0);
  assert.equal(setJaccard([], [1]), 0);
});

test("minhashJaccard = fraction of positionally-equal slots", () => {
  assert.equal(minhashJaccard(["1", "2", "3", "4"], ["1", "2", "3", "4"]), 1);
  assert.equal(minhashJaccard(["1", "2", "3", "4"], ["1", "2", "9", "9"]), 0.5);
  assert.equal(minhashJaccard(["1"], ["1", "2"]), 0); // length mismatch
});
