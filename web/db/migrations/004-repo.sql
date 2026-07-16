-- Source repositories attached to builds (VSS->git conversions, extracted
-- offline). One row per (build, repo name); the bytes live in the asset store:
-- every git blob is stored content-addressed by sha256, and manifest_sha256
-- names a JSON manifest blob describing commits/trees/blobs (see
-- src/lib/repo-manifest.ts). Rows are created only by scripts/attach-repo.ts —
-- re-ingest never touches this table (ingestRecord rewrites build_asset from
-- the record; attached repos must survive).
-- Idempotent — safe to re-run. Apply to every curator DB:
--   psql -d <db> -f db/migrations/004-repo.sql

CREATE TABLE IF NOT EXISTS build_repo (
    build_sha256    TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    name            TEXT NOT NULL,             -- URL segment; [A-Za-z0-9][A-Za-z0-9._-]{0,63}
    manifest_sha256 TEXT NOT NULL,             -- manifest blob in the asset store
    head_oid        TEXT NOT NULL,             -- denormalized for the build page card
    head_ref        TEXT,                      -- symbolic HEAD name, e.g. "master"
    commit_count    INT  NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (build_sha256, name)
);
CREATE INDEX IF NOT EXISTS idx_build_repo_manifest ON build_repo(manifest_sha256);
