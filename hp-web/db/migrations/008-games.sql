-- Game classification: a shared games table plus builds.game_id. Populated
-- by scripts/import-wiki-games.ts (wiki {{Prototype}} infobox "game" field,
-- joined to builds by archive sha1) and editable per build by moderators via
-- PATCH /api/build/<sha256> { game } (upserts the name, "" / null clears).
--
-- game_id follows the same reload semantics as name/lot/private: local DBs
-- are the source of truth on a full reload, so prod-side edits since the
-- last import are expected to be re-importable, not preserved.
-- games ids are PER-DATABASE (BIGSERIAL): any cross-DB copy of builds rows
-- must remap game_id through the game NAME, never copy raw ids between
-- databases.
--
-- Idempotent, safe to re-run. Apply to every prism DB:
--   psql -d <db> -f db/migrations/008-games.sql

CREATE TABLE IF NOT EXISTS games (
    id   BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

ALTER TABLE builds ADD COLUMN IF NOT EXISTS game_id BIGINT REFERENCES games(id);
CREATE INDEX IF NOT EXISTS idx_builds_game ON builds(game_id) WHERE game_id IS NOT NULL;
