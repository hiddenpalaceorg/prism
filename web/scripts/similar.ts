// Find builds similar to a stored one (CLI smoke test of the similarity tiers).
// Usage: npm run similar -- <sha256>   (env DATABASE_URL)

import pg from "pg";
import { deriveQueryFeatures } from "../src/lib/fingerprint";
import { findSimilar } from "../src/lib/queries";
import type { BuildRecord } from "../src/lib/types";

const sha = process.argv[2];
if (!sha) {
  console.error("usage: tsx scripts/similar.ts <sha256>");
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || "postgres:///curator_test",
  });
  const me = (await pool.query("SELECT record FROM builds WHERE sha256=$1", [sha])).rows[0];
  if (!me) {
    console.error("not found:", sha);
    process.exit(1);
  }
  const record = me.record as BuildRecord;
  const q = deriveQueryFeatures(record);
  const r = await findSimilar(pool, q);

  console.log(`query: ${q.name}\n`);
  console.log("Identical content:");
  r.identical_content.forEach((t) => console.log(`  ${t.name}`));
  if (!r.identical_content.length) console.log("  (none)");
  console.log("\nShared files (Jaccard):");
  r.shared_files.forEach((x) => console.log(`  ${x.jaccard?.toFixed(3)}  ${x.name}`));
  if (!r.shared_files.length) console.log("  (none)");
  console.log("\nSimilar chunks (MinHash Jaccard):");
  r.similar_chunks.forEach((x) => console.log(`  ${x.jaccard?.toFixed(3)}  ${x.name}`));
  if (!r.similar_chunks.length) console.log("  (none)");

  console.log("\nShared audio (matched / best Jaccard):");
  r.audio_neighbors.forEach((x) => console.log(`  ${x.matched_tracks} tracks (best ${x.best.toFixed(3)})  ${x.name}`));
  if (!r.audio_neighbors.length) console.log("  (none)");

  console.log("\nSame boot imports (imphash):");
  r.exe_imports.forEach((x) => console.log(`  ${x.name}`));
  if (!r.exe_imports.length) console.log("  (none)");

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
