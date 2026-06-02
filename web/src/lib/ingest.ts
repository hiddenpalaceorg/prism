// Ingest one canonical BuildRecord into Postgres: builds + text embedding,
// files + fileset, chunk signature, exe, audio. Shared by the
// bulk CLI ingester (scripts/ingest.ts) and the moderation accept endpoint.

import type { Pool } from "pg";
import { hexToId63, toSigned64, lshBands, flattenFiles, arrayLit, parseU64 } from "./fingerprint";
import { embed, toPgVector } from "./embed";
import type { BuildRecord } from "./types";

/** Anything with a pg-style `query` (Pool, Client, or PoolClient). */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

export async function ingestRecord(db: Queryable, rec: BuildRecord): Promise<void> {
  const sha = rec.image.sha256;
  const st = rec.structural;
  const comp = rec.composites;

  await db.query(
    `INSERT INTO builds (sha256,name,system,size,md5,sha1,content_hash,filtered_content_hash,
        file_count,total_size,max_depth,ext_histogram,text_doc,fingerprint_profile,record)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (sha256) DO UPDATE SET record=excluded.record`,
    [sha, rec.image.name, rec.info?.system ?? "", rec.image.size, rec.image.md5, rec.image.sha1,
     comp.content_hash ?? null, comp.filtered_content_hash ?? null, st.file_count, st.total_size, st.max_depth,
     JSON.stringify(st.ext_histogram ?? {}), rec.text_doc ?? "", rec.fingerprint_profile, rec]
  );

  // Text embedding from the text doc.
  if (rec.text_doc) {
    const vec = toPgVector(await embed(rec.text_doc));
    await db.query("UPDATE builds SET text_embedding=$1::vector WHERE sha256=$2", [vec, sha]);
  }

  const files = flattenFiles(rec.contents);
  await db.query("DELETE FROM files WHERE build_sha256=$1", [sha]);
  const fileset = new Set<string>();
  for (const f of files) {
    const id = hexToId63(f.sha1);
    if (id !== null) fileset.add(id.toString());
  }
  // Multi-row INSERT, chunked: 7 params/row, kept well under Postgres's 65535
  // bind-parameter ceiling (a large disc image can hold tens of thousands of files).
  const ROWS_PER_INSERT = 1000;
  for (let off = 0; off < files.length; off += ROWS_PER_INSERT) {
    const chunk = files.slice(off, off + ROWS_PER_INSERT);
    const rows: string[] = [];
    const params: unknown[] = [];
    for (const f of chunk) {
      const i = params.length;
      rows.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7})`);
      params.push(sha, f.path, f.name, f.size, f.md5 ?? null, f.sha1 ?? null, f.sha256 ?? null);
    }
    await db.query(
      `INSERT INTO files (build_sha256,path,name,size,md5,sha1,sha256) VALUES ${rows.join(",")}`,
      params
    );
  }
  await db.query(
    `INSERT INTO build_fileset (build_sha256,hashes) VALUES ($1,$2)
     ON CONFLICT (build_sha256) DO UPDATE SET hashes=excluded.hashes`,
    [sha, arrayLit([...fileset])]
  );

  if (rec.chunk_signature?.values?.length) {
    const mh = rec.chunk_signature.values
      .map(parseU64)
      .filter((x): x is bigint => x !== null)
      .map(toSigned64);
    if (mh.length) {
      const bands = lshBands(mh);
      await db.query(
        `INSERT INTO build_chunk_signature (build_sha256,minhash,lsh_bands) VALUES ($1,$2,$3)
         ON CONFLICT (build_sha256) DO UPDATE SET minhash=excluded.minhash, lsh_bands=excluded.lsh_bands`,
        [sha, arrayLit(mh.map(String)), arrayLit(bands.map(String))]
      );
    }
  }

  if (rec.resemblance?.values?.length) {
    const mh = rec.resemblance.values
      .map(parseU64)
      .filter((x): x is bigint => x !== null)
      .map(toSigned64);
    if (mh.length) {
      const bands = lshBands(mh);
      await db.query(
        `INSERT INTO build_resemblance (build_sha256,minhash,lsh_bands) VALUES ($1,$2,$3)
         ON CONFLICT (build_sha256) DO UPDATE SET minhash=excluded.minhash, lsh_bands=excluded.lsh_bands`,
        [sha, arrayLit(mh.map(String)), arrayLit(bands.map(String))]
      );
    }
  }

  if (rec.exe_fp && (rec.exe_fp.tlsh || rec.exe_fp.imphash)) {
    await db.query(
      `INSERT INTO exe_fp (build_sha256, tlsh, imphash) VALUES ($1,$2,$3)
       ON CONFLICT (build_sha256) DO UPDATE SET tlsh=excluded.tlsh, imphash=excluded.imphash`,
      [sha, rec.exe_fp.tlsh ?? null, rec.exe_fp.imphash ?? null]
    );
  }

  await db.query("DELETE FROM audio_fp WHERE build_sha256=$1", [sha]);
  for (const m of rec.media ?? []) {
    if (m.kind === "audio" && m.audio_fp?.length) {
      await db.query(
        "INSERT INTO audio_fp (build_sha256, track, subfp) VALUES ($1,$2,$3)",
        [sha, m.path, arrayLit(m.audio_fp.map(String))]
      );
    }
  }
}

/** Ingest one record atomically on a dedicated client (all-or-nothing). */
export async function ingestRecordTx(pool: Pool, rec: BuildRecord): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await ingestRecord(c, rec);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
