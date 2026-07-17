// Push every blob in the local content-addressed store to the S3 backend —
// the one-time migration when a deployment flips from local disk to S3 (and
// an idempotent re-sync if it's ever partially done: blobs the bucket already
// has are skipped). Local files are left in place; delete the local store
// only after flipping the app over and confirming it serves.
//
// Works in chunks (sweep for missing, then upload) with backoff retries, so
// a transient endpoint blip mid-run costs seconds, not the whole run.
// Usage: npm run push-assets        (env ASSET_STORE_DIR + ASSET_S3_*)

import fs from "node:fs";
import path from "node:path";
import {
  assetBlobPath,
  assetStoreDir,
  missingBlobs,
  s3Enabled,
  storeBlobFromFile,
  storeDescription,
} from "../src/lib/blobstore";
import { loadDotEnv } from "./dotenv";

// Parallel uploads: most blobs are small, so per-request latency (not
// bandwidth) dominates — tune PUSH_CONCURRENCY up for a far-away endpoint.
const UPLOAD_CONCURRENCY = Math.max(1, Number(process.env.PUSH_CONCURRENCY) || 8);

// One progress line (and one retry scope) per chunk.
const CHUNK = 2000;

/** Run `fn`, retrying with backoff on transient endpoint failures. */
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const delaysMs = [5_000, 30_000, 120_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= delaysMs.length) throw e;
      console.error(`${what}: ${(e as Error).message} — retrying in ${delaysMs[attempt] / 1000}s`);
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
}

async function main() {
  loadDotEnv();
  if (!s3Enabled()) {
    console.error("ASSET_S3_ENDPOINT is not set — nothing to push to");
    process.exit(1);
  }

  const root = assetStoreDir();
  const shas: string[] = [];
  for (const shard of fs.readdirSync(root).filter((d) => /^[0-9a-f]{2}$/.test(d)).sort()) {
    for (const name of fs.readdirSync(path.join(root, shard))) {
      if (/^[0-9a-f]{64}$/.test(name)) shas.push(name); // skips .tmp leftovers
    }
  }
  console.log(`local store ${root}: ${shas.length} blob(s) -> ${storeDescription()}`);

  let stored = 0;
  let failed = 0;
  for (let off = 0; off < shas.length; off += CHUNK) {
    const chunk = shas.slice(off, off + CHUNK);
    const missing = await withRetry("existence sweep", () => missingBlobs(chunk));
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(UPLOAD_CONCURRENCY, missing.length) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= missing.length) return;
          const sha = missing[i];
          try {
            await withRetry(sha, () => storeBlobFromFile(sha, assetBlobPath(sha), { keepSource: true }));
            stored++;
          } catch (e) {
            failed++;
            console.error(`  giving up on ${sha}: ${(e as Error).message}`);
          }
        }
      })
    );
    console.log(`  ${Math.min(off + CHUNK, shas.length)}/${shas.length} scanned, ${stored} stored, ${failed} failed`);
  }
  console.log(`push complete: ${stored} stored, ${shas.length - stored - failed} already present, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
