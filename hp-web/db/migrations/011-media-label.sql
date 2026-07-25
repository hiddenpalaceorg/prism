-- Physical-media photos get a label: front, back, or other. Nullable —
-- non-physical kinds and photos uploaded before this migration stay NULL
-- (the UI shows those as "other"). The OG card prefers label='front'.
--
-- Additive only: build_media is PROD-ONLY USER DATA (see 006-user-media.sql).
--
-- Idempotent, safe to re-run. Apply to every prism DB:
--   psql -d <db> -f db/migrations/011-media-label.sql

ALTER TABLE build_media ADD COLUMN IF NOT EXISTS label TEXT
    CHECK (label IN ('front','back','other'));
