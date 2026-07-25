import { test } from "node:test";
import assert from "node:assert/strict";
import { safeEqual } from "../src/lib/auth";

test("safeEqual matches only identical strings", () => {
  assert.equal(safeEqual("secret-token", "secret-token"), true);
  assert.equal(safeEqual("secret-token", "secret-tokeN"), false);
});

test("safeEqual handles null/undefined and unequal lengths without throwing", () => {
  assert.equal(safeEqual(null, "x"), false);
  assert.equal(safeEqual(undefined, "x"), false);
  assert.equal(safeEqual("", "x"), false);
  assert.equal(safeEqual("short", "longer-value"), false); // no timingSafeEqual length throw
});
