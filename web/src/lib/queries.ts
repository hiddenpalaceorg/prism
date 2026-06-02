// Search + similarity queries (the data layer behind the API routes).

import type { Pool } from "pg";
import { minhashJaccard, setJaccard, arrayLit, type QueryFeatures, type AudioTrack } from "./fingerprint";
import { tlshDiff } from "./tlsh";
import type { BuildRecord, SimilarityResult } from "./types";
import type { FusedBuild, TierKey } from "./tiers";

const AUDIO_MATCH_THRESHOLD = 0.3;
const TLSH_MAX_DISTANCE = 120; // below this ≈ similar executable

/** Audio: builds sharing audio tracks (per-track Jaccard over chroma sub-fp sets). */
export async function findAudioSimilar(
  pool: Pool,
  tracks: AudioTrack[],
  exclude: string,
  limit = 20
) {
  const perBuild = new Map<
    string,
    { sha256: string; name: string; system: string; matched_tracks: number; best: number }
  >();
  for (const qt of tracks) {
    if (!qt.subfp.length) continue;
    const r = await pool.query(
      `SELECT a.build_sha256 AS sha256, b.name, b.system, a.subfp
       FROM audio_fp a JOIN builds b ON b.sha256=a.build_sha256
       WHERE a.build_sha256<>$2 AND a.subfp && $1::bigint[]`,
      [arrayLit(qt.subfp), exclude]
    );
    // best matching candidate track per build for this query track
    const bestPerBuild = new Map<string, { name: string; system: string; j: number }>();
    for (const row of r.rows) {
      const j = setJaccard(qt.subfp, row.subfp as string[]);
      if (j < AUDIO_MATCH_THRESHOLD) continue;
      const prev = bestPerBuild.get(row.sha256);
      if (!prev || j > prev.j) bestPerBuild.set(row.sha256, { name: row.name, system: row.system, j });
    }
    for (const [sha, v] of bestPerBuild) {
      const e = perBuild.get(sha) || { sha256: sha, name: v.name, system: v.system, matched_tracks: 0, best: 0 };
      e.matched_tracks += 1;
      e.best = Math.max(e.best, v.j);
      perBuild.set(sha, e);
    }
  }
  return [...perBuild.values()]
    .sort((a, b) => b.matched_tracks - a.matched_tracks || b.best - a.best)
    .slice(0, limit);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Collapse the per-tier similarity lists (+ text neighbors) into one per-build matrix
 * of similarities in [0,1], for weighted fusion + filtering on the client. Distances
 * are converted to similarities (TLSH: 1 - d/max). One row per build that hit any tier.
 */
export function fuseSimilar(s: SimilarityResult, text: EmbeddingHit[]): FusedBuild[] {
  const map = new Map<string, FusedBuild>();
  const add = (sha: string, name: string, system: string, key: TierKey, sim: number) => {
    if (!(sim > 0)) return;
    let e = map.get(sha);
    if (!e) {
      e = { sha256: sha, name, system, scores: {}, caps: [] };
      map.set(sha, e);
    }
    if (!e.name && name) e.name = name;
    if (!e.system && system) e.system = system;
    e.scores[key] = Math.max(e.scores[key] ?? 0, sim);
  };
  for (const x of s.identical_content) add(x.sha256, x.name, x.system, "content", 1);
  for (const x of s.shared_files) add(x.sha256, x.name, x.system, "files", clamp01(x.jaccard ?? 0));
  for (const x of s.similar_chunks) add(x.sha256, x.name, x.system, "chunks", clamp01(x.jaccard ?? 0));
  for (const x of s.resemblance) add(x.sha256, x.name, x.system, "resemblance", clamp01(x.jaccard ?? 0));
  for (const x of s.exe_imports) add(x.sha256, x.name, x.system, "imphash", 1);
  for (const x of s.exe_similar) add(x.sha256, x.name, x.system, "tlsh", clamp01(1 - x.distance / TLSH_MAX_DISTANCE));
  for (const x of s.audio_neighbors) add(x.sha256, x.name, x.system, "audio", clamp01(x.best));
  for (const x of text) add(x.sha256, x.name, x.system, "text", clamp01(x.cosine));
  return [...map.values()];
}

/**
 * Which similarity tiers each build has the underlying data for. A tier is only fair
 * to count when *both* builds support it, so the fusion intersects these (see
 * `applicableTiers`). One indexed lookup over the candidate set.
 */
export async function getCapabilities(pool: Pool, shas: string[]): Promise<Map<string, TierKey[]>> {
  const out = new Map<string, TierKey[]>();
  if (!shas.length) return out;
  const r = await pool.query(
    `SELECT b.sha256,
       (b.content_hash IS NOT NULL)   AS content,
       (fs.build_sha256 IS NOT NULL)  AS files,
       (sk.build_sha256 IS NOT NULL)  AS chunks,
       (rs.build_sha256 IS NOT NULL)  AS resemblance,
       (ex.imphash IS NOT NULL)       AS imphash,
       (ex.tlsh IS NOT NULL)          AS tlsh,
       (au.build_sha256 IS NOT NULL)  AS audio,
       (b.text_embedding IS NOT NULL) AS text
     FROM builds b
     LEFT JOIN build_fileset fs     ON fs.build_sha256=b.sha256
     LEFT JOIN build_chunk_signature sk      ON sk.build_sha256=b.sha256
     LEFT JOIN build_resemblance rs ON rs.build_sha256=b.sha256
     LEFT JOIN exe_fp ex            ON ex.build_sha256=b.sha256
     LEFT JOIN (SELECT DISTINCT build_sha256 FROM audio_fp) au ON au.build_sha256=b.sha256
     WHERE b.sha256 = ANY($1)`,
    [shas]
  );
  const KEYS: TierKey[] = ["content", "files", "chunks", "resemblance", "imphash", "tlsh", "audio", "text"];
  for (const row of r.rows) {
    out.set(
      row.sha256,
      KEYS.filter((k) => row[k])
    );
  }
  return out;
}

/** Log a similarity check by sha256 (read-only telemetry). */
export async function logCheck(pool: Pool, sha256: string | null): Promise<void> {
  if (!sha256) return;
  await pool.query("INSERT INTO similarity_log (sha256) VALUES ($1)", [sha256]);
}

/** Fuse all-tier neighbors for a query build's derived features. */
export async function findSimilar(pool: Pool, q: QueryFeatures, limit = 20): Promise<SimilarityResult> {
  const exclude = q.sha256 || "";
  const out: SimilarityResult = {
    identical_content: [], shared_files: [], similar_chunks: [], resemblance: [], exe_imports: [], exe_similar: [], audio_neighbors: [],
  };

  if (q.content_hash) {
    const r = await pool.query(
      "SELECT sha256, name, system FROM builds WHERE content_hash=$1 AND sha256<>$2",
      [q.content_hash, exclude]
    );
    out.identical_content = r.rows;
  }

  if (q.fileset.length) {
    const r = await pool.query(
      `WITH q AS (SELECT $1::bigint[] AS h)
       SELECT b.sha256, b.name, b.system,
         cardinality(ARRAY(SELECT unnest(f.hashes) INTERSECT SELECT unnest(q.h)))::float
           / NULLIF(cardinality(ARRAY(SELECT unnest(f.hashes) UNION SELECT unnest(q.h))),0) AS jaccard
       FROM build_fileset f
       CROSS JOIN q
       JOIN builds b ON b.sha256=f.build_sha256
       WHERE f.build_sha256<>$2 AND f.hashes && q.h
       ORDER BY jaccard DESC LIMIT $3`,
      [arrayLit(q.fileset), exclude, limit]
    );
    out.shared_files = r.rows.map((x) => ({ ...x, jaccard: Number(x.jaccard) }));
  }

  if (q.bands?.length && q.minhash?.length) {
    const cand = await pool.query(
      `SELECT s.build_sha256 AS sha256, b.name, b.system, s.minhash
       FROM build_chunk_signature s JOIN builds b ON b.sha256=s.build_sha256
       WHERE s.build_sha256<>$2 AND s.lsh_bands && $1::bigint[]`,
      [arrayLit(q.bands), exclude]
    );
    const mine = q.minhash;
    out.similar_chunks = cand.rows
      .map((r) => ({
        sha256: r.sha256 as string,
        name: r.name as string,
        system: r.system as string,
        jaccard: minhashJaccard(mine, r.minhash as string[]),
      }))
      .sort((a, b) => b.jaccard - a.jaccard)
      .slice(0, limit);
  }

  // Resemblance: byte-shingle — candidates by shared LSH bands, ranked by
  // OPH slot agreement. Catches builds whose big files differ only by scattered small
  // edits (where chunk hashes collapse).
  if (q.resemblanceBands?.length && q.resemblanceMinhash?.length) {
    const cand = await pool.query(
      `SELECT s.build_sha256 AS sha256, b.name, b.system, s.minhash
       FROM build_resemblance s JOIN builds b ON b.sha256=s.build_sha256
       WHERE s.build_sha256<>$2 AND s.lsh_bands && $1::bigint[]`,
      [arrayLit(q.resemblanceBands), exclude]
    );
    const mine = q.resemblanceMinhash;
    out.resemblance = cand.rows
      .map((r) => ({
        sha256: r.sha256 as string,
        name: r.name as string,
        system: r.system as string,
        jaccard: minhashJaccard(mine, r.minhash as string[]),
      }))
      .sort((a, b) => b.jaccard - a.jaccard)
      .slice(0, limit);
  }

  // Exe imports: same boot-exe imports (PE imphash equality). TLSH-distance ranking is a
  // future refinement (needs a TLSH compare in the web stack).
  if (q.imphash) {
    const r = await pool.query(
      `SELECT e.build_sha256 AS sha256, b.name, b.system
       FROM exe_fp e JOIN builds b ON b.sha256=e.build_sha256
       WHERE e.imphash=$1 AND e.build_sha256<>$2`,
      [q.imphash, exclude]
    );
    out.exe_imports = r.rows;
  }

  // Exe TLSH: rank stored exe digests by distance (linear scan; small corpus).
  // A TLSH forest would index this at scale.
  if (q.tlsh) {
    const r = await pool.query(
      // Cap the linear TLSH scan to bound work on large corpora.
      `SELECT e.build_sha256 AS sha256, b.name, b.system, e.tlsh
       FROM exe_fp e JOIN builds b ON b.sha256=e.build_sha256
       WHERE e.tlsh IS NOT NULL AND e.build_sha256<>$1
       LIMIT 5000`,
      [exclude]
    );
    out.exe_similar = r.rows
      .map((row) => ({ sha256: row.sha256, name: row.name, system: row.system, distance: tlshDiff(q.tlsh!, row.tlsh) ?? Infinity }))
      .filter((x) => x.distance <= TLSH_MAX_DISTANCE)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  if (q.audioTracks.length) {
    out.audio_neighbors = await findAudioSimilar(pool, q.audioTracks, exclude, limit);
  }

  return out;
}

export interface EmbeddingHit {
  sha256: string;
  name: string;
  system: string;
  cosine: number;
}

/**
 * Text neighbors for a build already in the corpus — uses its stored embedding
 * (no re-embedding at query time). Empty if the build has no embedding.
 */
export async function findByEmbeddingOf(pool: Pool, sha256: string, limit = 20): Promise<EmbeddingHit[]> {
  const r = await pool.query(
    `WITH me AS (SELECT text_embedding FROM builds WHERE sha256=$1)
     SELECT b.sha256, b.name, b.system, 1 - (b.text_embedding <=> me.text_embedding) AS cosine
     FROM builds b CROSS JOIN me
     WHERE b.sha256<>$1 AND b.text_embedding IS NOT NULL AND me.text_embedding IS NOT NULL
     ORDER BY b.text_embedding <=> me.text_embedding
     LIMIT $2`,
    [sha256, limit]
  );
  return r.rows.map((x) => ({ ...x, cosine: Number(x.cosine) }));
}

/** Text: nearest builds by text-embedding cosine (pgvector). For a query vector
 *  (e.g. a live submission not yet in the corpus); corpus builds use findByEmbeddingOf. */
export async function findByEmbedding(
  pool: Pool,
  vectorLiteral: string,
  exclude: string,
  limit = 20
): Promise<EmbeddingHit[]> {
  const r = await pool.query(
    `SELECT sha256, name, system, 1 - (text_embedding <=> $1::vector) AS cosine
     FROM builds
     WHERE sha256<>$2 AND text_embedding IS NOT NULL
     ORDER BY text_embedding <=> $1::vector
     LIMIT $3`,
    [vectorLiteral, exclude, limit]
  );
  return r.rows.map((x) => ({ ...x, cosine: Number(x.cosine) }));
}

export interface SearchResult {
  mode: "hash" | "text";
  results: Array<{ sha256: string; name: string; system: string; sim?: number | null }>;
}

/** Filename FTS/fuzzy search, or exact hash lookup when the term looks like a hash. */
export async function search(pool: Pool, term: string, limit = 50): Promise<SearchResult> {
  const t = term.trim();
  if (/^[0-9a-fA-F]{8,}$/.test(t)) {
    const h = t.toLowerCase();
    const r = await pool.query(
      `SELECT DISTINCT b.sha256, b.name, b.system
       FROM builds b LEFT JOIN files f ON f.build_sha256=b.sha256
       WHERE b.sha256=$1 OR b.md5=$1 OR b.sha1=$1 OR b.content_hash=$1
          OR f.md5=$1 OR f.sha1=$1 OR f.sha256=$1
       LIMIT $2`,
      [h, limit]
    );
    return { mode: "hash", results: r.rows };
  }
  const r = await pool.query(
    `SELECT sha256, name, system, similarity(name,$1) AS sim
     FROM builds
     WHERE name % $1 OR to_tsvector('simple', text_doc) @@ plainto_tsquery('simple',$1)
     ORDER BY sim DESC NULLS LAST LIMIT $2`,
    [t, limit]
  );
  return { mode: "text", results: r.rows.map((x) => ({ ...x, sim: x.sim == null ? null : Number(x.sim) })) };
}

/** Enqueue a submission (dedup by sha256). */
export async function enqueueSubmission(pool: Pool, nickname: string, record: BuildRecord): Promise<string> {
  const sha = record?.image?.sha256;
  if (!sha) throw new Error("record missing image.sha256");
  await pool.query(
    `INSERT INTO submission_queue (sha256, nickname, record)
     VALUES ($1,$2,$3)
     ON CONFLICT (sha256) DO UPDATE SET nickname=excluded.nickname, record=excluded.record,
        status='queued', submitted_at=now(), reviewed_at=NULL`,
    [sha, nickname, record]
  );
  return sha;
}

export interface BuildRow {
  sha256: string;
  name: string;
  system: string;
  size: number;
  md5: string;
  sha1: string;
  content_hash: string;
  file_count: number;
  total_size: number;
  fingerprint_profile: string;
  ingested_at: string;
  record: BuildRecord;
}

export interface BuildListItem {
  sha256: string;
  name: string;
  system: string;
  file_count: number;
  total_size: number;
  ingested_at: string;
}

/// List stored builds, most recently ingested first (for the /builds index).
export async function listBuilds(pool: Pool, limit = 500): Promise<BuildListItem[]> {
  const r = await pool.query(
    `SELECT sha256, name, system, file_count, total_size, ingested_at
     FROM builds ORDER BY ingested_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows as BuildListItem[];
}

/// Fetch one stored build (with its full canonical record) by sha256.
export async function getBuild(pool: Pool, sha256: string): Promise<BuildRow | null> {
  const r = await pool.query(
    `SELECT sha256, name, system, size, md5, sha1, content_hash, file_count,
            total_size, fingerprint_profile, ingested_at, record
     FROM builds WHERE sha256=$1`,
    [sha256]
  );
  return (r.rows[0] as BuildRow) ?? null;
}

export async function submissionStatus(pool: Pool, sha256: string) {
  const r = await pool.query(
    "SELECT sha256, nickname, status, submitted_at, reviewed_at FROM submission_queue WHERE sha256=$1",
    [sha256]
  );
  return r.rows[0] || null;
}

export interface SubmissionListItem {
  sha256: string;
  nickname: string;
  status: string;
  submitted_at: string;
  reviewed_at: string | null;
  name: string;
  system: string;
  file_count: number;
}

/// List submissions (optionally filtered by status), newest first.
export async function listSubmissions(pool: Pool, status?: string, limit = 200): Promise<SubmissionListItem[]> {
  const where = status ? "WHERE status=$1" : "";
  const params = status ? [status, limit] : [limit];
  const r = await pool.query(
    `SELECT sha256, nickname, status, submitted_at, reviewed_at,
            record->'image'->>'name'         AS name,
            record->'info'->>'system'        AS system,
            (record->'structural'->>'file_count')::bigint AS file_count
     FROM submission_queue ${where}
     ORDER BY submitted_at DESC LIMIT $${status ? 2 : 1}`,
    params
  );
  return r.rows as SubmissionListItem[];
}

/// Mark a submission accepted/rejected. Returns the stored record on accept (so the
/// caller can ingest it), or null if the submission doesn't exist.
export async function setSubmissionStatus(
  pool: Pool,
  sha256: string,
  status: "accepted" | "rejected"
): Promise<BuildRecord | null> {
  const r = await pool.query(
    `UPDATE submission_queue SET status=$2, reviewed_at=now() WHERE sha256=$1 RETURNING record`,
    [sha256, status]
  );
  if (!r.rowCount) return null;
  return r.rows[0].record as BuildRecord;
}
