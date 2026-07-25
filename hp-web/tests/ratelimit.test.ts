import { test } from "node:test";
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { rateLimit, rateLimitCheck, clientKey } from "../src/lib/ratelimit";

// The limiter map is module-global, so each test uses a unique key.
let n = 0;
const uniq = () => `test-key-${n++}-${process.hrtime.bigint()}`;

test("rateLimitCheck allows up to the limit, then blocks with a retry hint", () => {
  const key = uniq();
  assert.equal(rateLimitCheck(key, 3, 60_000).ok, true);
  assert.equal(rateLimitCheck(key, 3, 60_000).ok, true);
  assert.equal(rateLimitCheck(key, 3, 60_000).ok, true);
  const blocked = rateLimitCheck(key, 3, 60_000);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60_000);
});

test("a fresh window (0ms) always allows", () => {
  const key = uniq();
  assert.equal(rateLimit(key, 1, 0), true);
  assert.equal(rateLimit(key, 1, 0), true); // window already elapsed → reset
});

function reqWithXff(xff?: string): NextRequest {
  return { headers: new Headers(xff ? { "x-forwarded-for": xff } : {}) } as unknown as NextRequest;
}

test("clientKey picks the hop counted from the right (unforgeable side)", () => {
  const prev = process.env.TRUSTED_PROXY_HOPS;
  try {
    delete process.env.TRUSTED_PROXY_HOPS; // default 1 hop
    assert.equal(clientKey(reqWithXff("1.1.1.1, 2.2.2.2, 3.3.3.3")), "3.3.3.3");

    process.env.TRUSTED_PROXY_HOPS = "2";
    assert.equal(clientKey(reqWithXff("1.1.1.1, 2.2.2.2, 3.3.3.3")), "2.2.2.2");

    process.env.TRUSTED_PROXY_HOPS = "0"; // XFF distrusted entirely
    assert.equal(clientKey(reqWithXff("1.1.1.1")), "unknown");
  } finally {
    if (prev === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = prev;
  }
});

test("clientKey falls back to a constant when XFF is absent", () => {
  const prev = process.env.TRUSTED_PROXY_HOPS;
  try {
    delete process.env.TRUSTED_PROXY_HOPS;
    assert.equal(clientKey(reqWithXff()), "unknown");
  } finally {
    if (prev === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = prev;
  }
});
