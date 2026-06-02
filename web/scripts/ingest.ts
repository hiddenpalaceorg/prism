// Ingest a desktop export bundle into Postgres.
// Usage: npm run ingest -- <bundle.zip | bundle.jsonl>   (env DATABASE_URL)
//
// Accepts either a portable `.zip` bundle (manifest.json + builds.jsonl, as
// produced by `curator export -o foo.zip`) or a raw `.jsonl` file. Either way
// records are streamed line-by-line so a large collection never has to fit in
// memory. Populates builds (+ text embedding), files, build_fileset,
// build_chunk_signature, exe_fp, audio_fp. The per-record work lives in
// src/lib/ingest.ts so the moderation accept endpoint reuses it.

import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import readline from "node:readline";
import type { Readable } from "node:stream";
import pg from "pg";
import { ingestRecordTx } from "../src/lib/ingest";
import type { BuildRecord } from "../src/lib/types";

// What this importer understands. A bundle whose manifest disagrees is rejected
// up front: a different fingerprint profile makes the similarity tiers
// incomparable, and a newer record schema may carry fields we don't ingest.
const EXPECTED_SCHEMA_VERSION = 1;
const EXPECTED_FINGERPRINT_PROFILE = "v1";

const bundle = process.argv[2];
if (!bundle) {
  console.error("usage: tsx scripts/ingest.ts <bundle.zip | bundle.jsonl>");
  process.exit(1);
}

interface Manifest {
  curator_bundle?: number;
  record_schema_version?: number;
  fingerprint_profile?: string;
  count?: number;
}

/** Read and validate `manifest.json` from a zip bundle (via `unzip -p`). */
function readManifest(zipPath: string): Manifest {
  let raw: string;
  try {
    raw = execFileSync("unzip", ["-p", zipPath, "manifest.json"], {
      encoding: "utf8",
      maxBuffer: 1 << 20,
    });
  } catch {
    throw new Error(`could not read manifest.json from ${zipPath} (is it a curator bundle?)`);
  }
  const m = JSON.parse(raw) as Manifest;
  if (m.record_schema_version !== EXPECTED_SCHEMA_VERSION) {
    throw new Error(
      `bundle record_schema_version ${m.record_schema_version} != expected ${EXPECTED_SCHEMA_VERSION}`
    );
  }
  if (m.fingerprint_profile !== EXPECTED_FINGERPRINT_PROFILE) {
    throw new Error(
      `bundle fingerprint_profile "${m.fingerprint_profile}" != expected "${EXPECTED_FINGERPRINT_PROFILE}" — ` +
        `similarity tiers would be incomparable`
    );
  }
  return m;
}

/** A line stream over the records, plus a cleanup/await handle for the source. */
function openRecords(path: string): { lines: Readable; done: Promise<void> } {
  if (path.endsWith(".zip")) {
    const m = readManifest(path);
    console.log(
      `bundle: ${m.count ?? "?"} records, schema v${m.record_schema_version}, profile ${m.fingerprint_profile}`
    );
    const child = spawn("unzip", ["-p", path, "builds.jsonl"]);
    const done = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`unzip exited with code ${code}`))
      );
    });
    return { lines: child.stdout, done };
  }
  return { lines: fs.createReadStream(path), done: Promise.resolve() };
}

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || "postgres:///curator_test",
  });
  let n = 0;
  try {
    const { lines, done } = openRecords(bundle);
    const rl = readline.createInterface({ input: lines, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      await ingestRecordTx(pool, JSON.parse(line) as BuildRecord);
      n++;
    }
    await done;
  } finally {
    await pool.end();
  }
  console.log(`ingested ${n} builds`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
