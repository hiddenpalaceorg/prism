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
in the content-addressed blob store for the build page's inline asset viewer.

## Blob store

Asset and repo blobs live in a content-addressed store (`src/lib/blobstore.ts`)
with two backends:

- **local** (default): `<ASSET_STORE_DIR>/<sha256[:2]>/<sha256>`, rooted at
  `./asset-store`.
- **s3**: any S3-compatible object store, selected by setting
  `ASSET_S3_ENDPOINT`. Keys mirror the local layout under
  `ASSET_S3_PREFIX` in `ASSET_S3_BUCKET` (default `curator`). Credentials come
  from `ASSET_S3_ACCESS_KEY_ID`/`ASSET_S3_SECRET_ACCESS_KEY` (or the SDK's
  default chain); `ASSET_S3_REGION` defaults to `us-east-1`, and
  `ASSET_S3_INSECURE_TLS=1` accepts a self-signed endpoint certificate.
  Reads are local-first (the local store doubles as a read cache and as the
  write buffer): submission uploads land on local disk instantly and a
  background drain pushes them to the bucket, so slow object stores never
  gate the upload path. `ASSET_STORE_DIR` remains the local root for upload
  staging and the ffmpeg caches. When a public gateway serves the bucket's key layout
  directly, set `ASSET_PUBLIC_BASE` to its origin: the raw asset route then
  308-redirects image/audio/video requests there (media sniffs fine without
  extensions), while text, PDF, and downloads keep the app's typed and
  sandboxed responses.

`npm run push-assets` uploads an existing local store to the s3 backend:
the one-time migration when a deployment flips to `ASSET_S3_ENDPOINT`
(idempotent, keeps local files). Scripts read `.env`/`.env.local` like the
app, so the store settings live in one place.

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
  blobs the store lacks; `PUT /api/submissions/<sha256>/assets/<assetSha>[?offset=N]`
  uploads one (raw body, ≤ 20MB total, must hash to `<assetSha>` and be referenced
  by the submitted record), in one shot or resumable chunks: chunks append at
  `offset` (0 restarts; a mismatch answers 409 with the staged offset, a short
  append 202 with the next one) and the last chunk hash-verifies and stores the
  blob. The desktop apps call these after submitting a record.
