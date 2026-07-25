-- Games gain a system and a URL slug. The same title on two systems is two
-- games (Sonic 3D Blast on Genesis vs Saturn), so identity moves from name
-- to (name, system). system is '' when unknown, never NULL, so the unique
-- pair behaves. slug is the /games/<slug> path segment
-- (<name-slug>--<system-slug>, name slug alone when system is ''), computed
-- in app code (lib/slug.ts gameSlug); rows keep NULL until the import script
-- or a moderator assignment fills it, and NULLs don't collide in the unique
-- index. Colliding slugs (near-duplicate wiki spellings) get "-<id>".
--
-- Idempotent, safe to re-run. Apply to every prism DB:
--   psql -d <db> -f db/migrations/009-game-system.sql

ALTER TABLE games ADD COLUMN IF NOT EXISTS system TEXT NOT NULL DEFAULT '';
ALTER TABLE games ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE games DROP CONSTRAINT IF EXISTS games_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS games_name_system_key ON games(name, system);
CREATE UNIQUE INDEX IF NOT EXISTS games_slug_key ON games(slug);
