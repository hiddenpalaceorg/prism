// Cache busting that reaches every app process.
//
// Production serves the app from two slots behind the :6800 front door (see
// deploy/slots.sh), and each slot has its own ISR cache. next/cache's
// revalidatePath only clears the cache of the process that ran it, so an edit
// handled by slot A would leave slot B serving the stale build page for the
// rest of its hour (`export const revalidate = 3600`). The page would flip
// between old and new depending on which slot answered. Mutation routes
// therefore bust caches through revalidateEverywhere, which revalidates
// locally and mirrors the same paths to the sibling slot.
//
// The sibling's origin comes from PEER_ORIGIN, set per slot by the deploy
// script. Unset (dev, a single instance, tests) this is exactly a local
// revalidate. The mirrored request goes straight to the sibling's port rather
// than back through the load balancer, which could route it right back here,
// is authenticated with the REFRESH_TOKEN that /api/refresh already takes, and
// carries PEER_HEADER so the receiving side does not mirror it back again.

import { revalidatePath, revalidateTag } from "next/cache";

/** Marks a mirrored revalidation, so the receiving slot does not bounce it back. */
export const PEER_HEADER = "x-peer-revalidate";

const PEER_TIMEOUT_MS = 5_000;

/** A path this app would revalidate: absolute, single-line, no host or scheme. */
export function isRevalidatePath(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= 512 &&
    v.startsWith("/") &&
    !v.startsWith("//") &&
    !/\s/.test(v)
  );
}

/** A cache tag this app would revalidate, e.g. `build-tree:<sha256>`. */
export function isRevalidateTag(v: unknown): v is string {
  return typeof v === "string" && /^[\w.:-]{1,128}$/.test(v);
}

/**
 * The request that mirrors these cache busts to the sibling slot, or null when
 * there is no sibling configured, no token to authenticate with, or nothing to
 * send. Split out from the sending so it can be tested without a request scope.
 */
export function peerRevalidateRequest(
  paths: string[],
  tags: string[],
  env: Record<string, string | undefined> = process.env
): { url: string; init: RequestInit } | null {
  const origin = env.PEER_ORIGIN?.replace(/\/+$/, "");
  const token = env.REFRESH_TOKEN;
  if (!origin || !token) return null;
  if (paths.length === 0 && tags.length === 0) return null;
  return {
    url: `${origin}/api/refresh`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-refresh-token": token,
        [PEER_HEADER]: "1",
      },
      body: JSON.stringify({ paths, tags }),
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      cache: "no-store",
    },
  };
}

/**
 * Revalidate these paths and tags on this process and on the sibling slot.
 * Pass `mirror: false` when already handling a mirrored request, so two slots
 * cannot bounce one bust back and forth.
 *
 * The local bust is synchronous. The returned promise settles when the mirror
 * has landed. Ignoring it keeps the old fire-and-forget behaviour, which is
 * what a bulk mutation wants. Await it when the caller is about to tell a
 * browser "done" and that browser will immediately re-fetch the page: the
 * refresh is load-balanced across both slots, so returning before the mirror
 * lands is a live race against serving the stale page back. It never rejects.
 */
export function revalidateEverywhere(
  paths: Iterable<string>,
  tags: Iterable<string> = [],
  opts: { mirror?: boolean } = {}
): Promise<void> {
  const p = [...new Set(paths)];
  const t = [...new Set(tags)];
  for (const path of p) revalidatePath(path);
  for (const tag of t) revalidateTag(tag, "max");

  if (opts.mirror === false) return Promise.resolve();
  const req = peerRevalidateRequest(p, t);
  if (!req) return Promise.resolve();
  // A sibling that cannot be reached right now is a stale page for a while,
  // not a failed request for the caller, so this resolves either way. Logged
  // so it is not silent.
  return fetch(req.url, req.init).then(
    (r) => {
      if (!r.ok) console.warn(`peer revalidate: ${req.url} -> ${r.status}`);
    },
    (err) => console.warn("peer revalidate failed:", err)
  );
}
