// Ingest one canonical BuildRecord into Postgres: builds + text embedding,
// files + fileset, chunk signature, exe, audio. Shared by the
// bulk CLI ingester (scripts/ingest.ts) and the moderation accept endpoint.

import type { Pool } from "pg";
import { hexToId63, toSigned64, lshBands, flattenFiles, arrayLit, parseU64, semanticDoc } from "./fingerprint";
import { embed, toPgVector } from "./embed";
import type { BuildRecord } from "./types";

/** Anything with a pg-style `query` (Pool, Client, or PoolClient). */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

// Postgres text/jsonb cannot store a literal NUL (U+0000), so a disc-header
// field that smuggled one through (see the adapter's _nullify) would otherwise
// abort the whole INSERT. Strip NUL from every string in the record — object
// keys included (ext_histogram keys carry mis-decoded UCS-2 filenames) — in the
// columns we extract and in the `record` jsonb we store verbatim — before it
// reaches the DB. Minimal on purpose: NUL is the only byte Postgres rejects, so
// we leave all other text untouched and don't second-guess the adapter.
function stripNulls<T>(value: T): T {
  if (typeof value === "string") {
    return (value.includes("\u0000") ? value.replace(/\u0000/g, "") : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(stripNulls) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[stripNulls(k)] = stripNulls(v);
    return out as T;
  }
  return value;
}

// The GIN index on to_tsvector('simple', text_doc) caps the lexeme pool at
// 1048575 bytes; a text_doc past that aborts the INSERT. The pool can't exceed
// the input's byte length, so capping the column (the full text stays in
// `record`) keeps the index valid at the cost of FTS on the truncated tail.
const TEXT_DOC_MAX_BYTES = 1_000_000;
function capTextDoc(s: string): string {
  if (Buffer.byteLength(s) <= TEXT_DOC_MAX_BYTES) return s;
  const buf = Buffer.from(s);
  let end = TEXT_DOC_MAX_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // don't split a UTF-8 sequence
  return buf.subarray(0, end).toString();
}

// Disc mastering date for the sortable builds.build_date column — volume
// creation date, else the header release date (YYYYMMDD normalized to
// YYYY-MM-DD so mixed sources sort together). Mirrors the backfill in
// db/migrations/001-fast-pages.sql.
function buildDate(rec: BuildRecord): string | null {
  const info = (rec.info ?? {}) as Record<string, unknown>;
  const pick = (section: unknown, key: string): string | null => {
    const v = section && typeof section === "object" ? (section as Record<string, unknown>)[key] : null;
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
    return null;
  };
  const raw = pick(info.volume, "creation_date") ?? pick(info.header, "release_date");
  if (!raw) return null;
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : raw;
}

export async function ingestRecord(
  db: Queryable,
  rec: BuildRecord,
  opts: { force?: boolean } = {}
): Promise<void> {
  rec = stripNulls(rec);
  const sha = rec.image.sha256;
  const st = rec.structural;
  const comp = rec.composites;

  // Skip-if-unchanged: a build's derived data (embedding, files, fingerprints)
  // is a pure function of its record, so re-ingesting an identical record would
  // recompute everything to the same values — wasting an embedding inference and
  // a full file rewrite per build. JSONB `=` is order-independent, so this is a
  // correct equality test; comparing against the stored record (post-stripNulls,
  // exactly as it was inserted) means a re-run of the same export touches each
  // unchanged build with a single indexed lookup instead. ingestRecordTx is
  // all-or-nothing, so an existing build row always has consistent derived data.
  // `force` (moderation accept) bypasses the skip: accepting must be authoritative,
  // rewriting the row and every derived table even when the record looks unchanged,
  // so it also repairs derived rows written by older ingest versions.
  if (!opts.force) {
    const seen = (await db.query(
      "SELECT 1 FROM builds WHERE sha256=$1 AND record = $2::jsonb",
      [sha, JSON.stringify(rec)]
    )) as { rows: unknown[] };
    if (seen.rows.length > 0) return;
  }

  await db.query(
    `INSERT INTO builds (sha256,name,system,size,md5,sha1,content_hash,filtered_content_hash,
        file_count,total_size,max_depth,ext_histogram,text_doc,fingerprint_profile,record,build_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (sha256) DO UPDATE SET
        name=excluded.name, system=excluded.system, size=excluded.size,
        md5=excluded.md5, sha1=excluded.sha1,
        content_hash=excluded.content_hash,
        filtered_content_hash=excluded.filtered_content_hash,
        file_count=excluded.file_count, total_size=excluded.total_size,
        max_depth=excluded.max_depth, ext_histogram=excluded.ext_histogram,
        text_doc=excluded.text_doc, fingerprint_profile=excluded.fingerprint_profile,
        record=excluded.record, build_date=excluded.build_date`,
    [sha, rec.image.name, rec.info?.system ?? "", rec.image.size, rec.image.md5, rec.image.sha1,
     comp.content_hash ?? null, comp.filtered_content_hash ?? null, st.file_count, st.total_size, st.max_depth,
     JSON.stringify(st.ext_histogram ?? {}), capTextDoc(rec.text_doc ?? ""), rec.fingerprint_profile, rec, buildDate(rec)]
  );

  // Semantic embedding from the build's identity (see semanticDoc), not the
  // filename-heavy text_doc. text_doc is still stored above for keyword/FTS.
  const sdoc = semanticDoc(rec);
  if (sdoc) {
    const vec = toPgVector(await embed(sdoc));
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
  // Viewable assets: metadata only — the blobs travel in the bundle zip and are
  // placed into the store by scripts/ingest.ts. Guard each row: records can
  // arrive from the submissions API, and a malformed sha256 must never become a
  // blob-store lookup key (the asset route interpolates it into a file path).
  // A null/absent list means the record was never asset-extracted — keep rows
  // from any earlier ingest; only an extracted list (even []) is authoritative.
  if (rec.assets != null) {
    await db.query("DELETE FROM build_asset WHERE build_sha256=$1", [sha]);
    const assets = rec.assets.filter(
      (a) =>
        typeof a?.path === "string" &&
        a.path &&
        typeof a.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(a.sha256) &&
        typeof a.mime === "string" &&
        typeof a.kind === "string" &&
        Number.isFinite(a.size)
    );
    for (let off = 0; off < assets.length; off += ROWS_PER_INSERT) {
      const chunk = assets.slice(off, off + ROWS_PER_INSERT);
      const rows: string[] = [];
      const params: unknown[] = [];
      for (const a of chunk) {
        const i = params.length;
        rows.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6})`);
        params.push(sha, a.path, a.sha256, a.size, a.mime, a.kind);
      }
      await db.query(
        `INSERT INTO build_asset (build_sha256,path,sha256,size,mime,kind) VALUES ${rows.join(",")}
         ON CONFLICT (build_sha256,path) DO NOTHING`,
        params
      );
    }
  }

  await db.query(
    `INSERT INTO build_fileset (build_sha256,hashes) VALUES ($1,$2)
     ON CONFLICT (build_sha256) DO UPDATE SET hashes=excluded.hashes`,
    [sha, arrayLit([...fileset])]
  );
  // Inverted copy for the shared-files tier (see fileset_entry in schema.sql).
  await db.query("DELETE FROM fileset_entry WHERE build_sha256=$1", [sha]);
  await db.query(
    "INSERT INTO fileset_entry (hash, build_sha256) SELECT unnest($2::bigint[]), $1",
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

/**
 * Recompute the audio-hash corpus frequencies (audio_idf) from audio_fp. df is
 * build-level (distinct builds containing each hash), which is what the IDF
 * weighting in the similarity query needs. Cheap to recompute wholesale, and
 * recomputing avoids the double-counting an incremental upsert would hit when a
 * build is re-ingested. Run after a bulk import or a moderation accept.
 */
export async function refreshAudioIdf(db: Queryable): Promise<void> {
  await db.query("TRUNCATE audio_idf");
  await db.query(
    `INSERT INTO audio_idf (hash, doc_count)
     SELECT h, count(DISTINCT build_sha256)
     FROM (SELECT build_sha256, unnest(subfp) AS h FROM audio_fp) t
     GROUP BY h`
  );
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
