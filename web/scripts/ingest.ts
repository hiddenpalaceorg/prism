// Ingest a desktop export bundle (JSONL of BuildRecords) into Postgres.
// Usage: npm run ingest -- <bundle.jsonl>   (env DATABASE_URL)
//
// Populates builds (+ text embedding), files, build_fileset,
// build_chunk_signature, exe_fp, audio_fp. The per-record work
// lives in src/lib/ingest.ts so the moderation accept endpoint reuses it.

import fs from "node:fs";
import pg from "pg";
import { ingestRecordTx } from "../src/lib/ingest";
import type { BuildRecord } from "../src/lib/types";

const bundle = process.argv[2];
if (!bundle) {
  console.error("usage: tsx scripts/ingest.ts <bundle.jsonl>");
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || "postgres:///curator_test",
  });
  let n = 0;
  try {
    const lines = fs.readFileSync(bundle, "utf8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      await ingestRecordTx(pool, JSON.parse(line) as BuildRecord);
      n++;
    }
  } finally {
    await pool.end();
  }
  console.log(`ingested ${n} builds`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
