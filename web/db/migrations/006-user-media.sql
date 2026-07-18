-- Community metadata: media uploads, notes, and completeness skip flags,
-- contributed by logged-in wiki users on the build pages.
--
-- PROD-ONLY USER DATA. On the production server these tables hold
-- contributions that exist nowhere else. Never drop, truncate, or reload
-- them from a local dump; schema changes must stay additive. The deploy
-- tooling preserves and restores them around any full DB reload.
--
-- build_skip is its own table (not columns on builds) on purpose: library
-- reloads rewrite builds, and user state must never ride on a library table.
--
-- Idempotent, safe to re-run. Apply to every prism DB:
--   psql -d <db> -f db/migrations/006-user-media.sql

-- Uploaded media, one row per (build, kind, file). The bytes live in the
-- blob store under the media/ namespace, content-addressed by sha256.
CREATE TABLE IF NOT EXISTS build_media (
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
CREATE INDEX IF NOT EXISTS idx_build_media_build ON build_media(build_sha256);
CREATE INDEX IF NOT EXISTS idx_build_media_sha256 ON build_media(sha256);

CREATE TABLE IF NOT EXISTS build_note (
    id           BIGSERIAL PRIMARY KEY,
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    body         TEXT NOT NULL,
    author       TEXT NOT NULL,           -- wiki username
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_build_note_build ON build_note(build_sha256);

-- Per-build "this category does not apply" flags for the completeness
-- columns on /builds (a build with 0 in a category shows orange unless the
-- category is skipped here).
CREATE TABLE IF NOT EXISTS build_skip (
    build_sha256     TEXT PRIMARY KEY REFERENCES builds(sha256) ON DELETE CASCADE,
    skip_notes       BOOLEAN NOT NULL DEFAULT FALSE,
    skip_screenshots BOOLEAN NOT NULL DEFAULT FALSE,
    skip_video       BOOLEAN NOT NULL DEFAULT FALSE,
    skip_physical    BOOLEAN NOT NULL DEFAULT FALSE
);
