-- Duplicate-name submissions: a submitted record whose image already exists
-- as a build, under a different name than both the build's display name and
-- its stored record's image name, is queued as kind='duplicate'. Accepting it
-- records the submitted name in build_duplicate instead of re-ingesting, so
-- the live build is never overwritten by a renamed copy of itself.
--
-- build_duplicate is PROD-ONLY USER DATA (same never-wipe rules as
-- build_media/build_note/build_skip): never drop, truncate, or reload it from
-- a local dump; the deploy tooling preserves and restores it around any full
-- DB reload.
--
-- Idempotent, safe to re-run. Apply to every prism DB:
--   psql -d <db> -f db/migrations/007-duplicates.sql

ALTER TABLE submission_queue
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'build'
        CHECK (kind IN ('build','duplicate'));

CREATE TABLE IF NOT EXISTS build_duplicate (
    id           BIGSERIAL PRIMARY KEY,
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE,
    name         TEXT NOT NULL,           -- the name the duplicate was submitted under
    nickname     TEXT NOT NULL,           -- who submitted it
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (build_sha256, name)
);
