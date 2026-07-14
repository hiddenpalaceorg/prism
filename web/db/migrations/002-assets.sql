-- Per-build browser-viewable assets (images/audio/text ≤ 20MB), extracted by
-- the desktop analyzer into a content-addressed store and shipped in export
-- bundles. Rows are metadata only; the bytes live on disk in ASSET_STORE_DIR
-- (blobs at <store>/<sha256[:2]>/<sha256>), placed there by scripts/ingest.ts.
-- Idempotent — safe to re-run. Apply to every curator DB:
--   psql -d <db> -f db/migrations/002-assets.sql
--
-- No backfill: records ingested before the analyzer grew asset extraction
-- carry no asset list. Re-analyzing + re-exporting a collection tops them up.

CREATE TABLE IF NOT EXISTS build_asset (
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    path         TEXT NOT NULL,           -- full path within the build (matches files.path)
    sha256       TEXT NOT NULL,           -- content hash = key into the blob store
    size         BIGINT NOT NULL,
    mime         TEXT NOT NULL,           -- as served; text is always text/plain
    kind         TEXT NOT NULL,           -- image|audio|video|text
    PRIMARY KEY (build_sha256, path)
);
CREATE INDEX IF NOT EXISTS idx_build_asset_sha256 ON build_asset(sha256);
