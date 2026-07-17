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
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import readline from "node:readline";
import type { Readable } from "node:stream";
import pg from "pg";
import { missingBlobs, storeBlobFromFile, storeDescription } from "../src/lib/blobstore";
import { ingestRecordTx, refreshAudioIdf } from "../src/lib/ingest";
import type { BuildRecord } from "../src/lib/types";
import { loadDotEnv } from "./dotenv";

loadDotEnv();

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

/** Unpack the bundle's asset blobs (`assets/<sha256>` members) into the
 *  content-addressed store. Blobs already present are skipped; writes land
 *  under their final name only once complete (storeBlobFromFile), so a crash
 *  can't leave a truncated blob. Returns how many blobs were added. */
async function unpackAssets(zipPath: string): Promise<number> {
  let listing: string;
  try {
    listing = execFileSync("unzip", ["-Z1", zipPath, "assets/*"], {
      encoding: "utf8",
      maxBuffer: 64 << 20,
    });
  } catch {
    return 0; // no assets/ members — a pre-assets bundle
  }
  const shas = listing
    .split("\n")
    .map((l) => l.trim().replace(/^assets\//, ""))
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
  const missing = await missingBlobs(shas);
  if (missing.length === 0) return 0;

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "curator-assets-"));
  try {
    execFileSync("unzip", ["-qo", zipPath, "assets/*", "-d", staging], { stdio: "ignore" });
    let n = 0;
    for (const sha of missing) {
      const src = path.join(staging, "assets", sha);
      if (!fs.existsSync(src)) continue;
      if ((await storeBlobFromFile(sha, src)) === "stored") n++;
    }
    return n;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
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
  let lineNo = 0;
  const failures: { line: number; sha?: string; name?: string; error: string }[] = [];
  try {
    // Blobs before rows: once a build_asset row exists, its blob is servable.
    if (bundle.endsWith(".zip")) {
      const added = await unpackAssets(bundle);
      if (added > 0) console.log(`unpacked ${added} asset blob(s) into ${storeDescription()}`);
    }
    const { lines, done } = openRecords(bundle);
    const rl = readline.createInterface({ input: lines, crlfDelay: Infinity });
    for await (const line of rl) {
      lineNo++;
      if (!line.trim()) continue;
      // Isolate each record: ingestRecordTx is its own transaction (rolled back
      // on error), so a single malformed/unstorable build is logged and skipped
      // rather than aborting the whole import and stranding later records.
      let rec: BuildRecord;
      try {
        rec = JSON.parse(line) as BuildRecord;
      } catch (e) {
        failures.push({ line: lineNo, error: `JSON parse: ${(e as Error).message}` });
        continue;
      }
      try {
        await ingestRecordTx(pool, rec);
        n++;
      } catch (e) {
        failures.push({
          line: lineNo,
          sha: rec.image?.sha256,
          name: rec.image?.name,
          error: (e as Error).message,
        });
      }
    }
    await done;
    // Corpus-wide step: recompute audio-hash frequencies once, after all the
    // per-record inserts, so the audio similarity tier can IDF-weight matches.
    if (n > 0) await refreshAudioIdf(pool);
  } finally {
    await pool.end();
  }
  console.log(`ingested ${n} builds`);
  if (failures.length) {
    console.error(`\n${failures.length} record(s) failed and were skipped:`);
    for (const f of failures) {
      console.error(`  line ${f.line}${f.name ? ` (${f.name})` : ""}: ${f.error}`);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
