-- Private builds and lots: hidden from the public build list, search, and
-- similar-builds surfaces, visible to moderators. A build is hidden when its
-- own flag is set OR its lot is in private_lots (so builds later assigned to
-- a private lot hide automatically). Direct build URLs stay reachable
-- (unlisted). Toggled via PATCH /api/build/<sha256> { private, lotPrivate }.
-- Idempotent — safe to re-run. Apply to every prism DB:
--   psql -d <db> -f db/migrations/005-private.sql

ALTER TABLE builds ADD COLUMN IF NOT EXISTS private BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS private_lots (
    lot TEXT PRIMARY KEY
);
