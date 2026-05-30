// Ingest a desktop export bundle (JSONL of BuildRecords) into Postgres.
// Usage: node scripts/ingest.mjs <bundle.jsonl>   (env DATABASE_URL)
//
// Populates builds, files, build_fileset (Tier 2), build_sketch (Tier 3),
// exe_fp/media_fp. text_embedding is left NULL (computed by a model at ingest — TODO).

import fs from "node:fs";
import pg from "pg";
import { hexToId63, toSigned64, lshBands, flattenFiles } from "./lib.mjs";

const bundle = process.argv[2];
if (!bundle) {
  console.error("usage: node scripts/ingest.mjs <bundle.jsonl>");
  process.exit(1);
}

async function ingestRecord(client, rec) {
  const img = rec.image;
  const sha = img.sha256;
  const st = rec.structural ?? {};
  const comp = rec.composites ?? {};

  await client.query(
    `INSERT INTO builds (sha256,name,system,size,md5,sha1,content_hash,filtered_content_hash,
        file_count,total_size,max_depth,ext_histogram,text_doc,fingerprint_profile,record)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (sha256) DO UPDATE SET record=excluded.record`,
    [sha, img.name, rec.info?.system ?? "", img.size, img.md5, img.sha1,
     comp.content_hash ?? "", comp.filtered_content_hash ?? "",
     st.file_count ?? 0, st.total_size ?? 0, st.max_depth ?? 0,
     JSON.stringify(st.ext_histogram ?? {}), rec.text_doc ?? "",
     rec.fingerprint_profile ?? "", rec]
  );

  // files + Tier-2 file-hash set
  const files = flattenFiles(rec.contents);
  await client.query("DELETE FROM files WHERE build_sha256=$1", [sha]);
  const fileset = new Set();
  for (const f of files) {
    await client.query(
      "INSERT INTO files (build_sha256,path,name,size,md5,sha1,sha256) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [sha, f.path, f.name, f.size, f.md5 ?? null, f.sha1 ?? null, f.sha256 ?? null]
    );
    const id = hexToId63(f.sha1);
    if (id !== null) fileset.add(id.toString());
  }
  await client.query(
    `INSERT INTO build_fileset (build_sha256,hashes) VALUES ($1,$2)
     ON CONFLICT (build_sha256) DO UPDATE SET hashes=excluded.hashes`,
    [sha, "{" + [...fileset].join(",") + "}"]
  );

  // Tier-3 sketch + LSH bands
  if (rec.sketch?.values?.length) {
    const mh = rec.sketch.values.map((v) => toSigned64(BigInt(v)));
    const bands = lshBands(mh);
    await client.query(
      `INSERT INTO build_sketch (build_sha256,minhash,lsh_bands) VALUES ($1,$2,$3)
       ON CONFLICT (build_sha256) DO UPDATE SET minhash=excluded.minhash, lsh_bands=excluded.lsh_bands`,
      [sha, "{" + mh.map(String).join(",") + "}", "{" + bands.map(String).join(",") + "}"]
    );
  }

  if (rec.exe_fp) {
    await client.query(
      `INSERT INTO exe_fp (build_sha256,tlsh,imphash) VALUES ($1,$2,$3)
       ON CONFLICT (build_sha256) DO UPDATE SET tlsh=excluded.tlsh, imphash=excluded.imphash`,
      [sha, rec.exe_fp.tlsh ?? null, rec.exe_fp.imphash ?? null]
    );
  }
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
      await ingestRecord(client, JSON.parse(line));
      n++;
    }
  } finally {
    await client.end();
  }
  console.log(`ingested ${n} builds`);
}

main().catch((e) => { console.error(e); process.exit(1); });
