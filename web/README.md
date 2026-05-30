# curator-web

Next.js + Postgres app: a searchable public listing of known builds and the
read-only **similarity service** the desktop GUIs call.

**Status:** scaffold. The database schema (`db/schema.sql`) is complete and reflects
all search + similarity tiers; the ingester, API routes, and UI are to be built.

## Pieces to build

- **Ingester** (`scripts/ingest.ts`): read an export bundle (JSONL of `BuildRecord`s,
  produced by `curator export`) or accepted submissions, then populate:
  - `builds`, `files` (FTS/trgm + exact-hash indexes)
  - `build_fileset` (Tier 2), `build_sketch` + `build_chunks` + `chunk_idf` (Tier 3),
    `media_fp` (Tier 4), `exe_fp` (Tier 5)
  - `text_embedding` via a local model (bge-small-en, 384-d) computed at ingest
- **`POST /api/similarity`** (read-only): body = sha256 + file-hash set + text doc +
  structural; log by sha256; fuse Tier 1–5 + embedding rankings; return neighbors.
  Does **not** ingest the submitted build.
- **`POST /api/submissions`** / **`GET /api/submissions/:sha256`**: enqueue (dedup by
  sha256) into `submission_queue`; report status. Accepted → ingester.
- **UI**: filename FTS/fuzzy search, exact hash lookup, build detail, similarity browse.

## DB setup

```sh
createdb curator
psql curator -f db/schema.sql
```

Requires Postgres with `pg_trgm`, `vector` (pgvector), and ideally `smlar` for exact
set-similarity (Tier 2); `intarray` is the fallback. See `db/schema.sql`.
