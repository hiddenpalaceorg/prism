// Which asset blobs a submitted build is allowed to upload: the upload
// endpoints only accept bytes whose sha256 is referenced by a known record
// (submission or library build), so the store can't be used as a free blob host.

import type { Pool } from "pg";
import type { AssetRef, BuildRecord } from "./types";
import { isSha256 } from "./validate";

/** Per-blob hard caps — mirror max_size() in the adapter's viewable.py:
 *  videos ship whole up to DVD-VOB scale, everything else stays small. */
export const MAX_ASSET_BLOB_BYTES = 64 * 1024 * 1024;
export const MAX_VIDEO_BLOB_BYTES = 1280 * 1024 * 1024;

function maxBlobBytes(kind: unknown): number {
  return kind === "video" ? MAX_VIDEO_BLOB_BYTES : MAX_ASSET_BLOB_BYTES;
}

/** Cap on one build's summed (claimed) asset bytes; uploads past it refuse. */
export const MAX_BUILD_ASSET_BYTES = 4 * 1024 * 1024 * 1024;

export interface ReferencedAssets {
  /** Deduplicated asset sha256 → claimed size, uploads must match exactly. */
  sizes: Map<string, number>;
  /** Sum of claimed sizes; compare against MAX_BUILD_ASSET_BYTES. */
  totalBytes: number;
}

function collect(assets: AssetRef[] | null | undefined): ReferencedAssets {
  const sizes = new Map<string, number>();
  let totalBytes = 0;
  for (const a of assets ?? []) {
    if (!isSha256(a.sha256) || sizes.has(a.sha256)) continue;
    const size = Number(a.size);
    if (!Number.isInteger(size) || size <= 0 || size > maxBlobBytes(a.kind)) continue;
    sizes.set(a.sha256, size);
    totalBytes += size;
  }
  return { sizes, totalBytes };
}

/** The asset refs of a pending/accepted submission, else of a library build,
 *  else null (unknown sha or rejected submission). */
export async function referencedAssets(pool: Pool, buildSha256: string): Promise<ReferencedAssets | null> {
  const sub = await pool.query<{ record: BuildRecord; status: string }>(
    "SELECT record, status FROM submission_queue WHERE sha256=$1",
    [buildSha256]
  );
  if (sub.rowCount && sub.rows[0].status !== "rejected") {
    return collect(sub.rows[0].record.assets);
  }
  const build = await pool.query<{ record: BuildRecord }>(
    "SELECT record FROM builds WHERE sha256=$1",
    [buildSha256]
  );
  if (build.rowCount) return collect(build.rows[0].record.assets);
  return null;
}
