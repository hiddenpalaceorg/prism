# curator-web

A searchable public listing of known builds and the read-only similarity service the desktop GUIs call.

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
Populates `builds`, `files`, `build_fileset`, `build_chunk_signature`,
`build_resemblance`, `exe_fp`, and `audio_fp`, computing the `text_embedding`
(all-MiniLM-L6-v2) and LSH bands at ingest.

## API

- `GET /api/search?q=<term>` — filename FTS + trigram fuzzy, or exact hash lookup when
  the term looks like a hash.
- `POST /api/similarity` — body = a canonical `BuildRecord`. Logs the check by sha256
  (read-only, not ingested) and returns fused similar-build neighbors.
- `POST /api/submissions` — body `{ nickname, record }`; enqueues for moderation
  (dedup by sha256). `GET /api/submissions/<sha256>` returns status.
