// Search + similarity queries (the data layer behind the API routes).

import type { Pool } from "pg";
import { minhashJaccard, arrayLit, type QueryFeatures } from "./fingerprint";
import type { BuildRecord, SimilarityResult } from "./types";

/** Log a similarity check by sha256 (read-only telemetry). */
export async function logCheck(pool: Pool, sha256: string | null): Promise<void> {
  if (!sha256) return;
  await pool.query("INSERT INTO similarity_log (sha256) VALUES ($1)", [sha256]);
}

/** Fuse Tier 1/2/3 neighbors for a query build's derived features. */
export async function findSimilar(pool: Pool, q: QueryFeatures, limit = 20): Promise<SimilarityResult> {
  const exclude = q.sha256 || "";
  const out: SimilarityResult = { tier1_twins: [], tier2: [], tier3: [] };

  if (q.content_hash) {
    const r = await pool.query(
      "SELECT sha256, name, system FROM builds WHERE content_hash=$1 AND sha256<>$2",
      [q.content_hash, exclude]
    );
    out.tier1_twins = r.rows;
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
    out.tier2 = r.rows.map((x) => ({ ...x, jaccard: Number(x.jaccard) }));
  }

  if (q.bands?.length && q.minhash?.length) {
    const cand = await pool.query(
      `SELECT s.build_sha256 AS sha256, b.name, b.system, s.minhash
       FROM build_sketch s JOIN builds b ON b.sha256=s.build_sha256
       WHERE s.build_sha256<>$2 AND s.lsh_bands && $1::bigint[]`,
      [arrayLit(q.bands), exclude]
    );
    const mine = q.minhash;
    out.tier3 = cand.rows
      .map((r) => ({
        sha256: r.sha256 as string,
        name: r.name as string,
        system: r.system as string,
        jaccard: minhashJaccard(mine, r.minhash as string[]),
      }))
      .sort((a, b) => b.jaccard - a.jaccard)
      .slice(0, limit);
  }

  return out;
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

export async function submissionStatus(pool: Pool, sha256: string) {
  const r = await pool.query(
    "SELECT sha256, nickname, status, submitted_at, reviewed_at FROM submission_queue WHERE sha256=$1",
    [sha256]
  );
  return r.rows[0] || null;
}
