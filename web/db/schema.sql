-- Prism web database schema (Postgres).
--
-- Fed by the desktop export bundle (JSONL of canonical BuildRecords) and the
-- submissions API. Implements the search + similarity tiers:
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

-- ── games ────────────────────────────────────────────────────────────────────
-- Shared classification: which game each build is a build of. Seeded from the
-- wiki {{Prototype}} infobox by scripts/import-wiki-games.ts, extended by
-- moderator edits (upsert by name+system). The same title on two systems is
-- two games, so identity is (name, system), '' system when unknown. slug is
-- the /games/<slug> segment (lib/slug.ts gameSlug, "-<id>" on collision).
-- ids are PER-DATABASE — cross-DB copies of builds rows must remap game_id
-- through (name, system), never raw ids.
CREATE TABLE games (
    id     BIGSERIAL PRIMARY KEY,
    name   TEXT NOT NULL,
    system TEXT NOT NULL DEFAULT '',
    slug   TEXT,
    UNIQUE (name, system)
);
CREATE UNIQUE INDEX games_slug_key ON games(slug);

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
    text_embedding        vector(384),              -- all-MiniLM-L6-v2, computed at ingest
    fingerprint_profile   TEXT NOT NULL,
    record                JSONB NOT NULL,           -- full canonical record
    ingested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    build_date            TEXT,                     -- volume creation date, else header release date (sortable copy)
    lot                   TEXT,                     -- moderator-assigned display group, e.g. "Sonic Month 2026"
    private               BOOLEAN NOT NULL DEFAULT FALSE, -- hidden from public list/search/similar (direct URL stays reachable)
    game_id               BIGINT REFERENCES games(id) -- which game this is a build of (wiki import / moderator)
);
CREATE INDEX idx_builds_content      ON builds(content_hash);
CREATE INDEX idx_builds_filtered     ON builds(filtered_content_hash);
CREATE INDEX idx_builds_system       ON builds(system);
CREATE INDEX idx_builds_name_lower   ON builds (lower(name));
CREATE INDEX idx_builds_name_trgm    ON builds USING gin (name gin_trgm_ops);
CREATE INDEX idx_builds_textdoc_fts  ON builds USING gin (to_tsvector('simple', text_doc));
CREATE INDEX idx_builds_embedding    ON builds USING hnsw (text_embedding vector_cosine_ops);
CREATE INDEX idx_builds_lot          ON builds(lot) WHERE lot IS NOT NULL;
CREATE INDEX idx_builds_game         ON builds(game_id) WHERE game_id IS NOT NULL;

-- Lots hidden from non-moderators; a build in a listed lot is hidden with it.
CREATE TABLE private_lots (
    lot TEXT PRIMARY KEY
);

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

-- ── per-build extracted assets ────────────────────────────────────────────────
-- Metadata for the build page's inline asset viewer; the bytes live in the
-- content-addressed blob store on disk (ASSET_STORE_DIR), filled at ingest.
-- Browser-viewable files (images/audio/text ≤ 20MB) are stored whole; every
-- other file's first 2KB is stored raw (kind 'binary') for the hex view.
CREATE TABLE build_asset (
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    path         TEXT NOT NULL,           -- full path within the build (matches files.path)
    sha256       TEXT NOT NULL,           -- content hash = key into the blob store
    size         BIGINT NOT NULL,         -- stored blob size (a head snippet's, not the file's)
    mime         TEXT NOT NULL,           -- as served; text is always text/plain
    kind         TEXT NOT NULL,           -- image|audio|video|source|text|binary
    file_date    TEXT,                    -- the file's own timestamp from the record contents (month timeline)
    PRIMARY KEY (build_sha256, path)
);
CREATE INDEX idx_build_asset_sha256 ON build_asset(sha256);

-- ── attached source repositories ──────────────────────────────────────────────
-- VSS->git conversions attached manually by scripts/attach-repo.ts. The bytes
-- live in the asset store: every git blob content-addressed by sha256, plus a
-- JSON manifest blob (commits/trees/blobs — see src/lib/repo-manifest.ts)
-- named by manifest_sha256. Re-ingest never touches this table (ingestRecord
-- rewrites build_asset from the record; attached repos must survive).
CREATE TABLE build_repo (
    build_sha256    TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    name            TEXT NOT NULL,             -- URL segment; [A-Za-z0-9][A-Za-z0-9._-]{0,63}
    manifest_sha256 TEXT NOT NULL,             -- manifest blob in the asset store
    head_oid        TEXT NOT NULL,             -- denormalized for the build page card
    head_ref        TEXT,                      -- symbolic HEAD name, e.g. "master"
    commit_count    INT  NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (build_sha256, name)
);
CREATE INDEX idx_build_repo_manifest ON build_repo(manifest_sha256);

-- ── identical-file overlap (set of truncated file-content hashes) ─────
-- bigint[] of file sha1s truncated to 63 bits; smlar (or intarray &&) for Jaccard.
CREATE TABLE build_fileset (
    build_sha256 TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    hashes       BIGINT[] NOT NULL
);
CREATE INDEX idx_fileset_gin ON build_fileset USING gin (hashes);

-- Inverted copy of build_fileset (one row per (hash, build)). The shared-files
-- similarity tier probes this by hash: Postgres never uses the GIN index for
-- `hashes && $big_array` (its cost model prices arrayoverlap near zero and
-- seq-scans), which made the tier O(|query| x |candidate|) per row — minutes
-- for 40k-file builds. Probing (hash, build) pairs + counting is the same
-- Jaccard (c / (|A|+|B|-c)) at index speed.
CREATE TABLE fileset_entry (
    hash         BIGINT NOT NULL,
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_fileset_entry_hash  ON fileset_entry(hash, build_sha256);
CREATE INDEX idx_fileset_entry_build ON fileset_entry(build_sha256);

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

-- corpus audio-hash frequency for IDF / stop-hash weighting (audio similarity).
-- doc_count = number of distinct builds whose audio contains the hash; a hash in
-- nearly every build (CDDA bass, adjacent-frame peaks) gets idf≈0 and washes out.
CREATE TABLE audio_idf (
    hash       BIGINT PRIMARY KEY,
    doc_count  BIGINT NOT NULL
);

-- ── exe binary similarity ──────────────────────────────────────────────────────
CREATE TABLE exe_fp (
    build_sha256 TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    tlsh         TEXT,
    imphash      TEXT
);
CREATE INDEX idx_exe_imphash ON exe_fp(imphash);

-- ── community metadata: media, notes, skip flags ─────────────────────────────
-- PROD-ONLY USER DATA. On the production server these tables hold wiki-user
-- contributions that exist nowhere else. Never drop, truncate, or reload them
-- from a local dump; schema changes must stay additive (the deploy tooling
-- preserves and restores them around any full DB reload). build_skip is its
-- own table, not columns on builds, so library reloads can never carry it.

-- Uploaded media, one row per (build, kind, file). The bytes live in the
-- blob store under the media/ namespace, content-addressed by sha256.
CREATE TABLE build_media (
    id            BIGSERIAL PRIMARY KEY,
    build_sha256  TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('screenshot','video','physical')),
    sha256        TEXT NOT NULL,          -- content hash = key under media/ in the blob store
    poster_sha256 TEXT,                   -- video poster still, also under media/
    filename      TEXT NOT NULL,
    content_type  TEXT NOT NULL,          -- sniffed server-side, not the client's claim
    size          BIGINT NOT NULL,
    author        TEXT NOT NULL,          -- wiki username
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (build_sha256, kind, sha256)
);
CREATE INDEX idx_build_media_build ON build_media(build_sha256);
CREATE INDEX idx_build_media_sha256 ON build_media(sha256);

CREATE TABLE build_note (
    id           BIGSERIAL PRIMARY KEY,
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    body         TEXT NOT NULL,
    author       TEXT NOT NULL,           -- wiki username
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at    TIMESTAMPTZ
);
CREATE INDEX idx_build_note_build ON build_note(build_sha256);

-- Per-build "this category does not apply" flags for the completeness
-- columns on /builds (0 in a category shows orange unless skipped here).
CREATE TABLE build_skip (
    build_sha256     TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    skip_notes       BOOLEAN NOT NULL DEFAULT FALSE,
    skip_screenshots BOOLEAN NOT NULL DEFAULT FALSE,
    skip_video       BOOLEAN NOT NULL DEFAULT FALSE,
    skip_physical    BOOLEAN NOT NULL DEFAULT FALSE
);

-- ── ops: similarity-check log + submission queue ─────────────────────────────
-- submission_queue is PROD-ONLY USER DATA on the production server (pending
-- and accepted user submissions): same never-wipe rules as above.
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
    -- 'duplicate': the image is already a build under a different name;
    -- accepting records the name in build_duplicate instead of re-ingesting.
    kind         TEXT NOT NULL DEFAULT 'build' CHECK (kind IN ('build','duplicate')),
    record       JSONB NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at  TIMESTAMPTZ
);
CREATE INDEX idx_subq_status ON submission_queue(status);

-- Names a build's image has circulated under besides its own — accepted
-- duplicate submissions. PROD-ONLY USER DATA: same never-wipe rules as above.
CREATE TABLE build_duplicate (
    id           BIGSERIAL PRIMARY KEY,
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    name         TEXT NOT NULL,           -- the name the duplicate was submitted under
    nickname     TEXT NOT NULL,           -- who submitted it
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (build_sha256, name)
);
