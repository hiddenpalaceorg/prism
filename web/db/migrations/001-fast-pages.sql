-- Fast page loads: inverted fileset table, sortable build_date column, and a
-- lower(name) index for the paginated /builds listing. Idempotent — safe to
-- re-run. Apply to every curator DB (local curator / curator_wiki and the
-- deployed ones):   psql -d <db> -f db/migrations/001-fast-pages.sql
--
-- fileset_entry is derived data (unnest of build_fileset.hashes); the backfill
-- below fills it for builds that don't have rows yet, and ingest keeps it in
-- step from then on.

BEGIN;

CREATE TABLE IF NOT EXISTS fileset_entry (
    hash         BIGINT NOT NULL,
    build_sha256 TEXT NOT NULL REFERENCES builds(sha256) ON DELETE CASCADE
);

ALTER TABLE builds ADD COLUMN IF NOT EXISTS build_date TEXT;

-- Backfill build_date from the record (detoasts every record — run-once cost).
-- YYYYMMDD header dates are normalized to YYYY-MM-DD so mixed sources sort together.
UPDATE builds SET build_date = sub.d
FROM (
  SELECT sha256,
         COALESCE(
           record->'info'->'volume'->>'creation_date',
           CASE WHEN record->'info'->'header'->>'release_date' ~ '^\d{8}$'
                THEN regexp_replace(record->'info'->'header'->>'release_date',
                                    '^(\d{4})(\d{2})(\d{2})$', '\1-\2-\3')
                ELSE record->'info'->'header'->>'release_date'
           END) AS d
  FROM builds
) sub
WHERE builds.sha256 = sub.sha256
  AND builds.build_date IS DISTINCT FROM sub.d;

INSERT INTO fileset_entry (hash, build_sha256)
SELECT DISTINCT unnest(bf.hashes), bf.build_sha256
FROM build_fileset bf
WHERE NOT EXISTS (SELECT 1 FROM fileset_entry fe WHERE fe.build_sha256 = bf.build_sha256);

COMMIT;

-- Indexes after the bulk load (cheaper than maintaining them during it).
CREATE UNIQUE INDEX IF NOT EXISTS idx_fileset_entry_hash  ON fileset_entry(hash, build_sha256);
CREATE INDEX IF NOT EXISTS idx_fileset_entry_build ON fileset_entry(build_sha256);
CREATE INDEX IF NOT EXISTS idx_builds_name_lower   ON builds (lower(name));

ANALYZE fileset_entry;
ANALYZE builds;
