-- Moderator-assigned lot: builds sharing a lot name (e.g. "Sonic Month 2026")
-- are displayed together — cross-linked on each build page and filterable on
-- /builds?lot=… . Assigned via PATCH /api/build/<sha256> (moderation token).
-- Re-ingest never touches it (the builds upsert only refreshes record/build_date).
-- Idempotent — safe to re-run. Apply to every curator DB:
--   psql -d <db> -f db/migrations/003-lot.sql

ALTER TABLE builds ADD COLUMN IF NOT EXISTS lot TEXT;
CREATE INDEX IF NOT EXISTS idx_builds_lot ON builds(lot) WHERE lot IS NOT NULL;
