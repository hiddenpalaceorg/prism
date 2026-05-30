// Simple in-memory fixed-window rate limiter.
// NOTE: per-instance/process only (not distributed) — a stopgap, not a real limiter.

import type { NextRequest } from "next/server";

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

// Opportunistically drop expired entries so a churn of distinct keys can't grow
// the map without bound (the limiter would otherwise be its own slow DoS).
function prune(now: number): void {
  if (windows.size < 10_000) return;
  for (const [k, w] of windows) if (now >= w.resetAt) windows.delete(k);
}

/** Returns true if the call for `key` is within `limit` per `windowMs`. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  prune(now);
  const w = windows.get(key);
  if (!w || now >= w.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (w.count >= limit) return false;
  w.count++;
  return true;
}

/** Derive a client key from the first x-forwarded-for hop (else a constant). */
export function clientKey(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || "unknown";
}
