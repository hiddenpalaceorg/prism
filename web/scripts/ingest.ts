// Ingest a desktop export bundle (JSONL of BuildRecords) into Postgres.
// Usage: npm run ingest -- <bundle.jsonl>   (env DATABASE_URL)
//
// Populates builds (+ text embedding), files, build_fileset (Tier 2),
// build_sketch (Tier 3), exe_fp (Tier 5), audio_fp (Tier 4). The per-record work
// lives in src/lib/ingest.ts so the moderation accept endpoint reuses it.

import fs from "node:fs";
import pg from "pg";
import { ingestRecord } from "../src/lib/ingest";
import type { BuildRecord } from "../src/lib/types";

const bundle = process.argv[2];
if (!bundle) {
  console.error("usage: tsx scripts/ingest.ts <bundle.jsonl>");
  process.exit(1);
}

async function main() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL || "postgres:///curator_test",
  });
  await client.connect();
  let n = 0;
  try {
    const lines = fs.readFileSync(bundle, "utf8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      await ingestRecord(client, JSON.parse(line) as BuildRecord);
      n++;
    }
  } finally {
    await client.end();
  }
  console.log(`ingested ${n} builds`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
