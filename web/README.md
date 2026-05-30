# curator-web

Next.js 16 (App Router, TypeScript, Tailwind 4) + Postgres: a searchable public
listing of known builds and the read-only **similarity service** the desktop GUIs call.

## Status

Working: DB schema, ingester, search + similarity + submission **API routes**, and a
minimal search UI. Validated against Postgres on the Sonic CD lineage.

To build: pgvector **text embedding** at ingest, richer UI (build detail / similarity
browse), submission moderation.

## Setup

```sh
npm install
createdb curator && psql curator -f db/schema.sql   # needs pg_trgm, vector, intarray
DATABASE_URL=postgres:///curator npm run dev
```

## Ingesting

```sh
# from a desktop export bundle (curator export -o builds.jsonl)
DATABASE_URL=postgres:///curator npm run ingest -- builds.jsonl
```
Populates `builds`, `files`, `build_fileset` (Tier 2), `build_sketch` (Tier 3), and
derives LSH bands. `text_embedding` is left NULL pending the embedding model.

## API

- `GET /api/search?q=<term>` — filename FTS + trigram fuzzy, or exact hash lookup when
  the term looks like a hash.
- `POST /api/similarity` — body = a canonical `BuildRecord`. Logs the check by sha256
  (read-only, not ingested) and returns fused Tier 1/2/3 neighbors.
- `POST /api/submissions` — body `{ nickname, record }`; enqueues for moderation
  (dedup by sha256). `GET /api/submissions/<sha256>` returns status.

## Layout

```
src/app/            UI (page.tsx) + API route handlers
src/lib/            db pool, fingerprint helpers, queries, shared types
scripts/            ingest.ts, similar.ts (run via tsx)
db/schema.sql       Postgres schema (tiers 1–5 + FTS + pgvector)
```

`src/lib/fingerprint.ts` mirrors the desktop fingerprint math (file-hash sets, LSH
bands) so query features derive identically from a `BuildRecord`.
