// Search + similarity queries (the data layer behind the API routes).

import type { Pool } from "pg";
import { minhashJaccard, arrayLit, type QueryFeatures, type AudioTrack } from "./fingerprint";
import { slugify } from "./slug";
import { tlshDiff } from "./tlsh";
import type { BuildRecord, SimilarityResult } from "./types";
import type { FusedBuild, TierKey } from "./tiers";

// Calibrated for the IDF-weighted scale below (not plain Jaccard): on the
// reference corpus, genuine audio siblings score ≥0.85 (regional variants,
// proto lineages) while unrelated builds top out around 0.47. 0.55 sits in that
// gap — it keeps real matches and drops the low-entropy "all music looks alike".
const AUDIO_MATCH_THRESHOLD = 0.55;
const TLSH_MAX_DISTANCE = 120; // below this ≈ similar executable

// A fingerprint present in more than this fraction of the audio corpus is too
// common to discriminate (idf≈0): it can't push a match over AUDIO_MATCH_THRESHOLD.
// We restrict both the candidate probe and the scoring to fingerprints with
// df≤cap; ubiquitous ones add ~0 weight, so genuine siblings (which share
// distinctive peaks) are still found. Without this, one near-universal CDDA peak
// makes `&&` match nearly the whole table.
const AUDIO_DF_CAP_FRACTION = 0.05;

// IDF-weighted Jaccard, computed entirely in Postgres so candidate fingerprint
// arrays never travel to Node (which made audio-heavy builds take ~17s). ALL of
// the query build's tracks are scored in one query: $1/$2 are parallel arrays of
// (track index, sub-fp). idf(h)=ln((N+1)/(df+1)), N=$3; restrict to distinctive
// fps (df≤cap=$4); per (query track, candidate track) sum idf over the
// distinctive intersection/union; a build "matches" a query track when its best
// candidate track scores ≥ threshold $5. Returns matched_tracks + best per build.
const AUDIO_SIM_SQL = `
WITH qf AS (
  SELECT u.qt, u.h, ln(($3::float + 1) / (i.doc_count + 1)) AS w
  FROM unnest($1::int[], $2::bigint[]) AS u(qt, h)
  JOIN audio_idf i ON i.hash = u.h
  WHERE i.doc_count <= $4::int
),
qt_w AS (SELECT qt, sum(w) AS wq FROM qf GROUP BY qt),
allq AS (SELECT COALESCE(array_agg(DISTINCT h), '{}'::bigint[]) AS hs FROM qf),
cand AS (
  SELECT a.build_sha256, a.ctid, a.subfp
  FROM audio_fp a, allq
  WHERE a.build_sha256 <> $6 AND cardinality(allq.hs) > 0 AND a.subfp && allq.hs
),
ce AS (
  SELECT c.build_sha256, c.ctid, cu.h, ln(($3::float + 1) / (i.doc_count + 1)) AS w
  FROM cand c
  CROSS JOIN LATERAL unnest(c.subfp) AS cu(h)
  JOIN audio_idf i ON i.hash = cu.h
  WHERE i.doc_count <= $4::int
),
csum AS (SELECT build_sha256, ctid, sum(w) AS cs FROM ce GROUP BY build_sha256, ctid),
pair AS (   -- (query track, candidate track) distinctive-intersection weight
  SELECT qf.qt, ce.build_sha256, ce.ctid, sum(ce.w) AS inter
  FROM qf JOIN ce ON ce.h = qf.h
  GROUP BY qf.qt, ce.build_sha256, ce.ctid
),
scored AS (
  SELECT p.qt, p.build_sha256,
         p.inter / NULLIF(qt_w.wq + (csum.cs - p.inter), 0) AS j
  FROM pair p
  JOIN qt_w ON qt_w.qt = p.qt
  JOIN csum ON csum.build_sha256 = p.build_sha256 AND csum.ctid = p.ctid
),
per_qt_build AS (   -- best candidate track per (query track, build)
  SELECT qt, build_sha256, max(j) AS bj FROM scored GROUP BY qt, build_sha256
)
SELECT pqb.build_sha256 AS sha256, b.name, b.system,
       count(*) FILTER (WHERE pqb.bj >= $5::float) AS matched_tracks,
       max(pqb.bj) AS best
FROM per_qt_build pqb JOIN builds b ON b.sha256 = pqb.build_sha256
GROUP BY pqb.build_sha256, b.name, b.system
HAVING count(*) FILTER (WHERE pqb.bj >= $5::float) > 0
ORDER BY matched_tracks DESC, best DESC
LIMIT $7::int`;

/** Audio: builds sharing audio tracks (per-track IDF-weighted Jaccard over chroma sub-fp sets). */
export async function findAudioSimilar(
  pool: Pool,
  tracks: AudioTrack[],
  exclude: string,
  limit = 20
) {
  const { rows: nr } = await pool.query(
    "SELECT count(DISTINCT build_sha256)::int AS n FROM audio_fp"
  );
  const n = (nr[0]?.n as number) ?? 0;
  if (!n) return [];
  const cap = Math.max(50, Math.floor(n * AUDIO_DF_CAP_FRACTION));
  // Flatten all tracks into parallel (track index, sub-fp) arrays for one query.
  const qtIdx: number[] = [];
  const fps: Array<string | number> = [];
  tracks.forEach((qt, i) => {
    for (const h of qt.subfp) {
      qtIdx.push(i);
      fps.push(h);
    }
  });
  if (!fps.length) return [];
  const r = await pool.query(AUDIO_SIM_SQL, [
    arrayLit(qtIdx),
    arrayLit(fps),
    n,
    cap,
    AUDIO_MATCH_THRESHOLD,
    exclude,
    limit,
  ]);
  return r.rows.map((row) => ({
    sha256: row.sha256 as string,
    name: row.name as string,
    system: row.system as string,
    matched_tracks: Number(row.matched_tracks),
    best: Number(row.best),
  }));
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// A build whose *only* signal is semantic text must clear this to be listed at all —
// weak text-only cosine neighbors are noise, not evidence of a related build.
const TEXT_ONLY_MIN = 0.7;

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
  return [...map.values()].filter((e) => {
    const keys = Object.keys(e.scores) as TierKey[];
    return keys.length !== 1 || keys[0] !== "text" || (e.scores.text ?? 0) >= TEXT_ONLY_MIN;
  });
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

/** Fuse all-tier neighbors for a query build's derived features. The tiers are
 *  independent queries, so they run concurrently (bounded by the pool size). */
export async function findSimilar(pool: Pool, q: QueryFeatures, limit = 20): Promise<SimilarityResult> {
  const exclude = q.sha256 || "";
  const out: SimilarityResult = {
    identical_content: [], shared_files: [], similar_chunks: [], resemblance: [], exe_imports: [], exe_similar: [], audio_neighbors: [],
  };
  const tiers: Promise<void>[] = [];

  if (q.content_hash) {
    tiers.push(pool.query(
      "SELECT sha256, name, system FROM builds WHERE content_hash=$1 AND sha256<>$2",
      [q.content_hash, exclude]
    ).then((r) => { out.identical_content = r.rows; }));
  }

  // Shared files: exact Jaccard over the file-hash sets, computed from the
  // inverted fileset_entry table — |A∩B| by indexed probe + count, and
  // |A∪B| = |A| + |B| − |A∩B| from the stored cardinalities. Identical scores
  // to intersecting the arrays pairwise, without the seq-scan-per-candidate
  // arrayoverlap that took minutes on 40k-file builds.
  if (q.fileset.length) {
    tiers.push(pool.query(
      `WITH q AS (SELECT DISTINCT h FROM unnest($1::bigint[]) AS u(h)),
            qn AS (SELECT count(*)::float AS n FROM q),
            inter AS (
              SELECT fe.build_sha256, count(*)::float AS c
              FROM fileset_entry fe JOIN q ON q.h = fe.hash
              WHERE fe.build_sha256 <> $2
              GROUP BY fe.build_sha256
            )
       SELECT b.sha256, b.name, b.system,
              i.c / (qn.n + cardinality(f.hashes) - i.c) AS jaccard
       FROM inter i
       CROSS JOIN qn
       JOIN build_fileset f ON f.build_sha256 = i.build_sha256
       JOIN builds b ON b.sha256 = i.build_sha256
       ORDER BY jaccard DESC LIMIT $3`,
      [arrayLit(q.fileset), exclude, limit]
    ).then((r) => {
      out.shared_files = r.rows.map((x) => ({ ...x, jaccard: Number(x.jaccard) }));
    }));
  }

  if (q.bands?.length && q.minhash?.length) {
    const mine = q.minhash;
    tiers.push(pool.query(
      `SELECT s.build_sha256 AS sha256, b.name, b.system, s.minhash
       FROM build_chunk_signature s JOIN builds b ON b.sha256=s.build_sha256
       WHERE s.build_sha256<>$2 AND s.lsh_bands && $1::bigint[]`,
      [arrayLit(q.bands), exclude]
    ).then((cand) => {
      out.similar_chunks = cand.rows
        .map((r) => ({
          sha256: r.sha256 as string,
          name: r.name as string,
          system: r.system as string,
          jaccard: minhashJaccard(mine, r.minhash as string[]),
        }))
        .sort((a, b) => b.jaccard - a.jaccard)
        .slice(0, limit);
    }));
  }

  // Resemblance: byte-shingle — candidates by shared LSH bands, ranked by
  // OPH slot agreement. Catches builds whose big files differ only by scattered small
  // edits (where chunk hashes collapse).
  if (q.resemblanceBands?.length && q.resemblanceMinhash?.length) {
    const mine = q.resemblanceMinhash;
    tiers.push(pool.query(
      `SELECT s.build_sha256 AS sha256, b.name, b.system, s.minhash
       FROM build_resemblance s JOIN builds b ON b.sha256=s.build_sha256
       WHERE s.build_sha256<>$2 AND s.lsh_bands && $1::bigint[]`,
      [arrayLit(q.resemblanceBands), exclude]
    ).then((cand) => {
      out.resemblance = cand.rows
        .map((r) => ({
          sha256: r.sha256 as string,
          name: r.name as string,
          system: r.system as string,
          jaccard: minhashJaccard(mine, r.minhash as string[]),
        }))
        .sort((a, b) => b.jaccard - a.jaccard)
        .slice(0, limit);
    }));
  }

  // Exe imports: same boot-exe imports (PE imphash equality). TLSH-distance ranking is a
  // future refinement (needs a TLSH compare in the web stack).
  if (q.imphash) {
    tiers.push(pool.query(
      `SELECT e.build_sha256 AS sha256, b.name, b.system
       FROM exe_fp e JOIN builds b ON b.sha256=e.build_sha256
       WHERE e.imphash=$1 AND e.build_sha256<>$2`,
      [q.imphash, exclude]
    ).then((r) => { out.exe_imports = r.rows; }));
  }

  // Exe TLSH: rank stored exe digests by distance (linear scan; small corpus).
  // A TLSH forest would index this at scale.
  if (q.tlsh) {
    tiers.push(pool.query(
      // Cap the linear TLSH scan to bound work on large corpora.
      `SELECT e.build_sha256 AS sha256, b.name, b.system, e.tlsh
       FROM exe_fp e JOIN builds b ON b.sha256=e.build_sha256
       WHERE e.tlsh IS NOT NULL AND e.build_sha256<>$1
       LIMIT 5000`,
      [exclude]
    ).then((r) => {
      out.exe_similar = r.rows
        .map((row) => ({ sha256: row.sha256, name: row.name, system: row.system, distance: tlshDiff(q.tlsh!, row.tlsh) ?? Infinity }))
        .filter((x) => x.distance <= TLSH_MAX_DISTANCE)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit);
    }));
  }

  if (q.audioTracks.length) {
    tiers.push(findAudioSimilar(pool, q.audioTracks, exclude, limit).then((r) => {
      out.audio_neighbors = r;
    }));
  }

  await Promise.all(tiers);
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
 *
 * Two steps on purpose: fetching the vector first lets the neighbor query
 * order by `<=> $param`, which the HNSW index can serve. Joining the vector in
 * (`ORDER BY b.emb <=> me.emb`) forces a full seq scan + sort over every
 * embedding in the corpus (~1.9s at 16k builds vs ~40ms indexed).
 */
export async function findByEmbeddingOf(pool: Pool, sha256: string, limit = 20): Promise<EmbeddingHit[]> {
  const r = await pool.query(
    "SELECT text_embedding::text AS v FROM builds WHERE sha256=$1 AND text_embedding IS NOT NULL",
    [sha256]
  );
  const v = r.rows[0]?.v as string | undefined;
  if (!v) return [];
  return findByEmbedding(pool, v, sha256, limit);
}

/** Text: nearest builds by text-embedding cosine (pgvector). For a query vector
 *  (e.g. a live submission not yet in the corpus); corpus builds use findByEmbeddingOf. */
export async function findByEmbedding(
  pool: Pool,
  vectorLiteral: string,
  exclude: string,
  limit = 20
): Promise<EmbeddingHit[]> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // The HNSW scan yields at most hnsw.ef_search candidates (default 40),
    // which would silently cap the result below `limit` (and the self row eats
    // one more). SET LOCAL scopes the raise to this transaction.
    await c.query("SELECT set_config('hnsw.ef_search', $1, true)", [
      String(Math.min(Math.max(limit + 20, 40), 1000)),
    ]);
    const r = await c.query(
      `SELECT sha256, name, system, 1 - (text_embedding <=> $1::vector) AS cosine
       FROM builds
       WHERE sha256<>$2 AND text_embedding IS NOT NULL
       ORDER BY text_embedding <=> $1::vector
       LIMIT $3`,
      [vectorLiteral, exclude, limit]
    );
    await c.query("COMMIT");
    return r.rows.map((x) => ({ ...x, cosine: Number(x.cosine) }));
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
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
  /** Disc mastering date — volume creation, else the header release date. */
  build_date: string | null;
}

export type BuildSortKey = "name" | "system" | "build_date" | "file_count" | "total_size";

export interface BuildsPageOpts {
  q?: string;
  system?: string;
  sort?: BuildSortKey;
  dir?: "asc" | "desc";
  offset?: number;
  limit?: number;
}

export interface BuildsPageResult {
  rows: BuildListItem[];
  /** Builds matching the filter (not just this page). */
  total: number;
  /** All systems in the corpus (for the filter dropdown). */
  systems: string[];
}

// Whitelist of sortable columns — `sort` is interpolated into ORDER BY, so it
// must map through this table, never straight from user input.
const BUILD_SORT: Record<BuildSortKey, string> = {
  name: "lower(name)",
  system: "system",
  build_date: "build_date",
  file_count: "file_count",
  total_size: "total_size",
};

/// One page of the /builds index, filtered and sorted in SQL. Replaces the
/// old ship-everything listBuilds: 16k+ rows made a 6MB payload and multi-second
/// renders; the browser now only ever gets one page.
export async function listBuildsPage(pool: Pool, opts: BuildsPageOpts = {}): Promise<BuildsPageResult> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.q?.trim()) {
    // Escape LIKE metacharacters so a user's "100%" searches literally.
    params.push("%" + opts.q.trim().replace(/[\\%_]/g, "\\$&") + "%");
    conds.push(`name ILIKE $${params.length}`);
  }
  if (opts.system) {
    params.push(opts.system);
    conds.push(`system = $${params.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const key = opts.sort && BUILD_SORT[opts.sort] ? opts.sort : "name";
  const dir = opts.dir === "desc" ? "DESC" : "ASC";
  // Missing dates always sort last regardless of direction; lower(name) breaks ties.
  const order =
    key === "name"
      ? `lower(name) ${dir}`
      : `${BUILD_SORT[key]} ${dir}${key === "build_date" ? " NULLS LAST" : ""}, lower(name)`;

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const [rows, count, systems] = await Promise.all([
    pool.query(
      `SELECT sha256, name, system, file_count, total_size, ingested_at, build_date
       FROM builds ${where} ORDER BY ${order}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    pool.query(`SELECT count(*)::int AS n FROM builds ${where}`, params),
    pool.query("SELECT DISTINCT system FROM builds ORDER BY system"),
  ]);
  return {
    rows: rows.rows as BuildListItem[],
    total: count.rows[0].n as number,
    systems: systems.rows.map((r) => r.system as string),
  };
}

/** One extracted asset of a build, for the build page's inline viewer. */
export interface BuildAsset {
  path: string;
  sha256: string;
  size: number;
  mime: string;
  kind: string; // image | audio | video | source | text | binary (head snippet)
}

/// A build's viewable assets, in path order (one indexed lookup).
export async function getBuildAssets(pool: Pool, sha256: string): Promise<BuildAsset[]> {
  const r = await pool.query(
    `SELECT path, sha256, size::float8 AS size, mime, kind
     FROM build_asset WHERE build_sha256=$1 ORDER BY path`,
    [sha256]
  );
  return r.rows as BuildAsset[];
}

/// Resolve a /builds/ URL param (hex prefix + optional slug) to a stored build.
/// A full 64-hex sha resolves exactly; a shorter prefix must match a unique
/// build — if two builds ever share a prefix, the slug disambiguates.
export async function resolveBuild(
  pool: Pool,
  hex: string,
  slug: string | null
): Promise<{ sha256: string; name: string } | null> {
  if (hex.length === 64) {
    const r = await pool.query("SELECT sha256, name FROM builds WHERE sha256=$1", [hex]);
    return (r.rows[0] as { sha256: string; name: string }) ?? null;
  }
  // Range probe instead of LIKE so the pkey index serves it under any collation
  // (values are lowercase hex, so appending 'g' upper-bounds every extension).
  const r = await pool.query(
    "SELECT sha256, name FROM builds WHERE sha256 >= $1 AND sha256 < ($1 || 'g') LIMIT 3",
    [hex]
  );
  const rows = r.rows as Array<{ sha256: string; name: string }>;
  if (rows.length === 1) return rows[0];
  if (rows.length > 1 && slug) {
    const bySlug = rows.filter((row) => slugify(row.name) === slug);
    if (bySlug.length === 1) return bySlug[0];
  }
  return null;
}

export interface BuildMetaRow {
  sha256: string;
  name: string;
  system: string;
  file_count: number;
  total_size: number;
  build_date: string | null;
  /** Display title from the canonical record, when the system extractor found one. */
  title: string | null;
}

/// The handful of scalar fields social-preview metadata needs — the full
/// record (MBs of jsonb) stays out of generateMetadata.
export async function getBuildMeta(pool: Pool, sha256: string): Promise<BuildMetaRow | null> {
  const r = await pool.query(
    `SELECT sha256, name, system, file_count, total_size, build_date,
            record->'info'->>'title' AS title
     FROM builds WHERE sha256=$1`,
    [sha256]
  );
  return (r.rows[0] as BuildMetaRow) ?? null;
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
