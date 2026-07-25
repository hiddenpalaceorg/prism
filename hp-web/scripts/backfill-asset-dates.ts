// Fill build_asset.file_date for rows ingested before migration 010, from
// each build's record contents tree (the same mapping ingest now applies).
// Usage: npx tsx scripts/backfill-asset-dates.ts [--all]   (env DATABASE_URL)
// By default only NULL file_date rows are touched; --all recomputes every row.

import pg from "pg";
import { assetFileDates } from "../src/lib/ingest";
import type { Node } from "../src/lib/types";
import { loadDotEnv } from "./dotenv";

async function main() {
  loadDotEnv();
  const all = process.argv.includes("--all");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || "postgres:///prism_test",
    max: 2,
  });
  const builds = (
    await pool.query(
      `SELECT DISTINCT build_sha256 AS sha FROM build_asset ${all ? "" : "WHERE file_date IS NULL"} ORDER BY 1`
    )
  ).rows as { sha: string }[];

  let updated = 0;
  for (const { sha } of builds) {
    const r = await pool.query("SELECT record->'contents' AS contents FROM builds WHERE sha256=$1", [sha]);
    const contents = (r.rows[0]?.contents ?? []) as Node[];
    const dates = assetFileDates(contents);
    const paths = (
      await pool.query(
        `SELECT path FROM build_asset WHERE build_sha256=$1 ${all ? "" : "AND file_date IS NULL"}`,
        [sha]
      )
    ).rows.map((x) => x.path as string);
    const pairs = paths.flatMap((p) => {
      const d = dates.get(p);
      return d ? [{ p, d }] : [];
    });
    if (pairs.length) {
      const res = await pool.query(
        `UPDATE build_asset b SET file_date = u.d
         FROM unnest($2::text[], $3::text[]) AS u(p, d)
         WHERE b.build_sha256=$1 AND b.path = u.p`,
        [sha, pairs.map((x) => x.p), pairs.map((x) => x.d)]
      );
      updated += res.rowCount ?? 0;
    }
    console.log(`${sha.slice(0, 10)}: ${pairs.length}/${paths.length} dated`);
  }
  console.log(`updated ${updated} rows across ${builds.length} builds`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
