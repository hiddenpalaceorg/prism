// Server-side loader for attached repo manifests (see repo-manifest.ts for
// the format and scripts/attach-repo.ts for the producer). Manifests are
// multi-MB and content-addressed, so this is a module-level LRU of the parsed
// + indexed form, not unstable_cache (which would re-serialize the whole
// manifest into Next's incremental cache per revalidation window).

import { readFile } from "node:fs/promises";
import { unstable_cache } from "next/cache";
import { assetBlobPath } from "./assets";
import { getPool } from "./db";
import { indexManifest, REPO_MANIFEST_VERSION, type RepoIndex, type RepoManifest } from "./repo-manifest";

// An indexed manifest runs a few x its JSON size in memory; four bounds the
// worst case to low hundreds of MB while covering every repo a page or its
// API burst realistically touches.
const MAX_CACHED = 4;
const lru = new Map<string, RepoIndex>(); // insertion order = recency

/** The parsed + indexed manifest blob, or null when it's missing from the
 *  store on this host or unreadable. Content-addressed, so entries never
 *  go stale. */
export async function loadRepo(manifestSha256: string): Promise<RepoIndex | null> {
  const hit = lru.get(manifestSha256);
  if (hit) {
    lru.delete(manifestSha256); // re-insert to refresh recency
    lru.set(manifestSha256, hit);
    return hit;
  }
  let manifest: RepoManifest;
  try {
    manifest = JSON.parse(await readFile(assetBlobPath(manifestSha256), "utf8")) as RepoManifest;
  } catch {
    return null; // row landed before the blob synced, or the store is elsewhere
  }
  if (manifest.version !== REPO_MANIFEST_VERSION) return null;
  const idx = indexManifest(manifest);
  lru.set(manifestSha256, idx);
  if (lru.size > MAX_CACHED) lru.delete(lru.keys().next().value!);
  return idx;
}

// The gate that keeps the /api/repo routes from serving arbitrary store
// blobs: only a manifest some build_repo row points at resolves, and blob
// oids are then validated against that manifest's blobs map. Tiny row check,
// cached like the asset route's meta lookup.
export const repoAttached = unstable_cache(
  async (manifestSha256: string): Promise<boolean> => {
    const r = await getPool().query("SELECT 1 FROM build_repo WHERE manifest_sha256=$1 LIMIT 1", [
      manifestSha256,
    ]);
    return r.rows.length > 0;
  },
  ["repo-attached"],
  { revalidate: 3600 }
);
