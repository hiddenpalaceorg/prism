-- Curator web database schema (Postgres).
--
-- Fed by the desktop export bundle (JSONL of canonical BuildRecords) and the
-- submissions API. Implements the search + similarity tiers from PLAN.md:
--   content identity         -> equality on content_hash
--   identical-file overlap   -> smlar/GIN Jaccard over file-hash sets
--   chunk similarity          -> LSH-banded MinHash over chunk sets
--   byte-shingle resemblance -> LSH-banded OPH over byte shingles
--   perceptual media         -> pHash Hamming / Chromaprint
--   exe binary similarity    -> imphash equality + TLSH
--   + filename FTS/fuzzy, exact hash lookup, text embedding (pgvector)

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy filename search
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector: text embedding ANN
-- CREATE EXTENSION IF NOT EXISTS smlar;  -- exact set similarity (identical-file overlap); build/install separately
CREATE EXTENSION IF NOT EXISTS intarray;  -- fallback array overlap if smlar unavailable

-- ── builds ───────────────────────────────────────────────────────────────────
CREATE TABLE builds (
    sha256                TEXT PRIMARY KEY,         -- image identity / lookup key
    name                  TEXT NOT NULL,
    system                TEXT NOT NULL,
    size                  BIGINT NOT NULL,
    md5                   TEXT NOT NULL,
    sha1                  TEXT NOT NULL,
    content_hash          TEXT,                     -- content identity (NULL when no file hashes)
    filtered_content_hash TEXT,                     -- content identity (NULL when no file hashes)
    file_count            BIGINT NOT NULL,
    total_size            BIGINT NOT NULL,
    max_depth             INT NOT NULL DEFAULT 0,
    ext_histogram         JSONB NOT NULL DEFAULT '{}',
    text_doc              TEXT NOT NULL DEFAULT '',
    text_embedding        vector(384),              -- bge-small-en, computed at ingest
    fingerprint_profile   TEXT NOT NULL,
    record                JSONB NOT NULL,           -- full canonical record
    ingested_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_builds_content      ON builds(content_hash);
CREATE INDEX idx_builds_filtered     ON builds(filtered_content_hash);
CREATE INDEX idx_builds_system       ON builds(system);
CREATE INDEX idx_builds_name_trgm    ON builds USING gin (name gin_trgm_ops);
CREATE INDEX idx_builds_textdoc_fts  ON builds USING gin (to_tsvector('simple', text_doc));
CREATE INDEX idx_builds_embedding    ON builds USING hnsw (text_embedding vector_cosine_ops);

-- ── files (per-build) — filename FTS/fuzzy + exact hash lookup ────────────────
CREATE TABLE files (
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    path         TEXT NOT NULL,
    name         TEXT NOT NULL,
    size         BIGINT,
    md5          TEXT,
    sha1         TEXT,
    sha256       TEXT
);
CREATE INDEX idx_files_build     ON files(build_sha256);
CREATE INDEX idx_files_name_trgm ON files USING gin (name gin_trgm_ops);
CREATE INDEX idx_files_sha1      ON files(sha1);
CREATE INDEX idx_files_md5       ON files(md5);
CREATE INDEX idx_files_sha256    ON files(sha256);

-- ── identical-file overlap (set of truncated file-content hashes) ─────
-- bigint[] of file sha1s truncated to 63 bits; smlar (or intarray &&) for Jaccard.
CREATE TABLE build_fileset (
    build_sha256 TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    hashes       BIGINT[] NOT NULL
);
CREATE INDEX idx_fileset_gin ON build_fileset USING gin (hashes);

-- ── chunk similarity (MinHash + LSH bands) ──────────────────────────────────
CREATE TABLE build_chunk_signature (
    build_sha256 TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    minhash      BIGINT[] NOT NULL,   -- k-slot weighted-MinHash signature
    lsh_bands    BIGINT[] NOT NULL    -- b band hashes (candidate generation)
);
CREATE INDEX idx_chunk_signature_bands ON build_chunk_signature USING gin (lsh_bands);

-- ── byte-shingle resemblance (OPH MinHash + LSH bands) ─────────────────────────
-- Robust where chunk hashes collapse: many small *scattered* edits across a big file.
CREATE TABLE build_resemblance (
    build_sha256 TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    minhash      BIGINT[] NOT NULL,   -- k-slot OPH byte-shingle signature
    lsh_bands    BIGINT[] NOT NULL    -- b band hashes (candidate generation)
);
CREATE INDEX idx_resemblance_bands ON build_resemblance USING gin (lsh_bands);

-- raw chunk sets retained server-side (IDF re-weighting + media diff)
CREATE TABLE build_chunks (
    build_sha256 TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    chunks       BIGINT[] NOT NULL    -- per build (multiset); per-file in JSONB sidecar if needed
);
-- corpus chunk frequency for IDF / stop-chunk weighting (chunk similarity)
CREATE TABLE chunk_idf (
    chunk      BIGINT PRIMARY KEY,
    doc_count  BIGINT NOT NULL
);

-- ── perceptual media ───────────────────────────────────────────────────────────
CREATE TABLE media_fp (
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    path         TEXT NOT NULL,
    kind         TEXT NOT NULL,       -- image|audio
    phash        BIGINT,              -- 64-bit perceptual hash (images), Hamming distance
    chromaprint  TEXT                 -- compact audio fingerprint
);
CREATE INDEX idx_media_build ON media_fp(build_sha256);
CREATE INDEX idx_media_phash ON media_fp(phash);

-- audio acoustic fingerprint: a chroma sub-fingerprint set per CDDA track,
-- compared by Jaccard (GIN), same machinery as identical-file overlap.
CREATE TABLE audio_fp (
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    track        TEXT NOT NULL,
    subfp        BIGINT[] NOT NULL
);
CREATE INDEX idx_audio_build ON audio_fp(build_sha256);
CREATE INDEX idx_audio_gin   ON audio_fp USING gin (subfp);

-- ── exe binary similarity ──────────────────────────────────────────────────────
CREATE TABLE exe_fp (
    build_sha256 TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    tlsh         TEXT,
    imphash      TEXT
);
CREATE INDEX idx_exe_imphash ON exe_fp(imphash);

-- ── ops: similarity-check log + submission queue ─────────────────────────────
CREATE TABLE similarity_log (
    id          BIGSERIAL PRIMARY KEY,
    sha256      TEXT NOT NULL,         -- queried build identity (may be unknown to corpus)
    checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_simlog_sha ON similarity_log(sha256);

CREATE TABLE submission_queue (
    sha256       TEXT PRIMARY KEY,
    nickname     TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'queued',  -- queued|accepted|rejected
    record       JSONB NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at  TIMESTAMPTZ
);
CREATE INDEX idx_subq_status ON submission_queue(status);
