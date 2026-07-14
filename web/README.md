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
# from a desktop export bundle (curator export -o builds.zip)
DATABASE_URL=postgres:///curator npm run ingest -- builds.zip
```
Populates `builds`, `files`, `build_fileset`, `build_chunk_signature`,
`build_resemblance`, `exe_fp`, `audio_fp`, and `build_asset`, computing the
`text_embedding` (all-MiniLM-L6-v2) and LSH bands at ingest. A `.zip` bundle
also carries the viewable-asset blobs (`assets/<sha256>` members), which land
in the content-addressed store at `ASSET_STORE_DIR` (default `./asset-store`)
for the build page's inline asset viewer.

## API

- `GET /api/search?q=<term>` — filename FTS + trigram fuzzy, or exact hash lookup when
  the term looks like a hash.
- `GET /api/asset/<sha256>` — one viewable asset from the blob store (immutable,
  range-capable; text always served as `text/plain`).
- `POST /api/similarity` — body = a canonical `BuildRecord`. Logs the check by sha256
  (read-only, not ingested) and returns fused similar-build neighbors.
- `POST /api/submissions` — body `{ nickname, record }`; enqueues for moderation
  (dedup by sha256). `GET /api/submissions/<sha256>` returns status.
- `GET /api/submissions/<sha256>/assets` — which of the build's referenced asset
  blobs the store lacks; `PUT /api/submissions/<sha256>/assets/<assetSha>` uploads
  one (raw body ≤ 20MB, must hash to `<assetSha>` and be referenced by the
  submitted record). The desktop apps call these after submitting a record.
