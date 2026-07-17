// Push every blob in the local content-addressed store to the S3 backend —
// the one-time migration when a deployment flips from local disk to S3 (and
// an idempotent re-sync if it's ever partially done: blobs the bucket already
// has are skipped). Local files are left in place; delete the local store
// only after flipping the app over and confirming it serves.
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
  console.log(`local store ${root}: ${shas.length} blob(s)`);

  const missing = await missingBlobs(shas);
  console.log(`${shas.length - missing.length} already in ${storeDescription()}, pushing ${missing.length}`);

  let pushed = 0;
  let failed = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, missing.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= missing.length) return;
        const sha = missing[i];
        try {
          await storeBlobFromFile(sha, assetBlobPath(sha), { keepSource: true });
          pushed++;
        } catch (e) {
          failed++;
          console.error(`  ${sha}: ${(e as Error).message}`);
        }
        if ((pushed + failed) % 200 === 0) console.log(`  ${pushed + failed}/${missing.length}`);
      }
    })
  );
  console.log(`pushed ${pushed} blob(s)${failed ? `, ${failed} FAILED` : ""}`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
