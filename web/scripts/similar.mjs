// Find builds similar to a catalogued one, fusing Tier 1/2/3.
// Usage: node scripts/similar.mjs <sha256>   (env DATABASE_URL)

import pg from "pg";
import { minhashJaccard } from "./lib.mjs";

const sha = process.argv[2];
if (!sha) {
  console.error("usage: node scripts/similar.mjs <sha256>");
  process.exit(1);
}
const pool = new pg.Client({ connectionString: process.env.DATABASE_URL || "postgres:///curator_test" });
await pool.connect();

async function main() {
  const me = (await pool.query(
    `SELECT b.name, b.content_hash, b.filtered_content_hash, f.hashes, s.minhash
     FROM builds b
     LEFT JOIN build_fileset f ON f.build_sha256=b.sha256
     LEFT JOIN build_sketch  s ON s.build_sha256=b.sha256
     WHERE b.sha256=$1`, [sha]
  )).rows[0];
  if (!me) { console.error("not found:", sha); process.exit(1); }
  console.log(`query: ${me.name}\n`);

  // Tier 1 — exact content identity
  const twins = (await pool.query(
    `SELECT sha256, name FROM builds WHERE content_hash=$1 AND sha256<>$2`,
    [me.content_hash, sha]
  )).rows;

  // Tier 2 — identical-file overlap (GIN && candidate gen, exact Jaccard rerank)
  const t2 = (await pool.query(
    `WITH q AS (SELECT $1::bigint[] AS h)
     SELECT b.sha256, b.name,
       cardinality(ARRAY(SELECT unnest(f.hashes) INTERSECT SELECT unnest(q.h)))::float
         / NULLIF(cardinality(ARRAY(SELECT unnest(f.hashes) UNION SELECT unnest(q.h))),0) AS jaccard
     FROM build_fileset f
     CROSS JOIN q
     JOIN builds b ON b.sha256=f.build_sha256
     WHERE f.build_sha256<>$2 AND f.hashes && q.h
     ORDER BY jaccard DESC LIMIT 10`,
    [me.hashes, sha]
  )).rows;

  // Tier 3 — chunk-similarity via LSH-band candidates, MinHash Jaccard rerank
  const cand = (await pool.query(
    `SELECT s.build_sha256, b.name, s.minhash
     FROM build_sketch s JOIN builds b ON b.sha256=s.build_sha256
     WHERE s.build_sha256<>$2
       AND s.lsh_bands && (SELECT lsh_bands FROM build_sketch WHERE build_sha256=$1)`,
    [sha, sha]
  )).rows;
  const mine = me.minhash;
  const t3 = cand.map((r) => ({
    name: r.name,
    jaccard: minhashJaccard(mine, r.minhash),
  })).sort((a, b) => b.jaccard - a.jaccard).slice(0, 10);

  console.log("Tier 1 — content twins (identical contents):");
  twins.forEach((t) => console.log(`  ${t.name}`));
  if (!twins.length) console.log("  (none)");

  console.log("\nTier 2 — identical-file overlap (Jaccard):");
  t2.forEach((r) => console.log(`  ${r.jaccard?.toFixed(3)}  ${r.name}`));
  if (!t2.length) console.log("  (none)");

  console.log("\nTier 3 — chunk similarity (MinHash Jaccard, LSH candidates):");
  t3.forEach((r) => console.log(`  ${r.jaccard.toFixed(3)}  ${r.name}`));
  if (!t3.length) console.log("  (none)");

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
