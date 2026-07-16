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
  return rateLimitCheck(key, limit, windowMs).ok;
}

/** `rateLimit` plus, when limited, milliseconds until the window resets. */
export function rateLimitCheck(
  key: string,
  limit: number,
  windowMs: number
): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  prune(now);
  const w = windows.get(key);
  if (!w || now >= w.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterMs: 0 };
  }
  if (w.count >= limit) return { ok: false, retryAfterMs: w.resetAt - now };
  w.count++;
  return { ok: true, retryAfterMs: 0 };
}

// Reverse-proxy hops in front of the app (env TRUSTED_PROXY_HOPS, default 1).
// X-Forwarded-For grows on the RIGHT — each proxy appends the address it received
// the connection from — so the real client sits `hops` entries from the end. A
// remote client can forge entries only on the LEFT, which counting from the right
// never selects. (The old code read the leftmost entry: exactly the forgeable one,
// letting one client rotate it to mint unlimited rate-limit buckets.) Set this to
// the number of trusted proxies in the deployment; 0 disables XFF trust entirely
// (every caller shares one bucket — correct only when nothing fronts the app).
function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw == null || raw === "") return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

/** Derive a client key from the trusted x-forwarded-for hop (else a constant). */
export function clientKey(request: NextRequest): string {
  const hops = trustedProxyHops();
  if (hops > 0) {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length >= hops) return parts[parts.length - hops];
    }
  }
  return "unknown";
}
