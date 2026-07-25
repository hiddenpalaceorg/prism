-- Per-asset file date (the timestamp of the file inside the build, from the
-- record's contents tree), for the game pages' month timeline. TEXT in the
-- record's own "YYYY-MM-DD HH:MM:SS" shape, like builds.build_date; NULL
-- when the container format carries no dates. Filled at ingest; existing
-- rows are backfilled by scripts/backfill-asset-dates.ts.
--
-- Idempotent, safe to re-run. Apply to every prism DB:
--   psql -d <db> -f db/migrations/010-asset-dates.sql

ALTER TABLE build_asset ADD COLUMN IF NOT EXISTS file_date TEXT;
