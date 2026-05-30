# Curator v2 — Build Plan

A ground-up rewrite. **No old code is reused** — only concepts. The sole external
dependency carried forward is **ps2exe** (latest), used as the ISO/container engine.

## Progress log & resume guide (updated 2026-05-29)

Work lives on branch **`drx/new`** (9 commits; not yet merged/pushed). README.md has
the live status table. Commit rules: ≤5–7 word messages, **no AI attribution**
(`~/.claude/settings.json` → `attribution: {commit:"",pr:""}`).

**Commits so far (newest first):**
```
a93cdf8  Add self-contained adapter bundle script
108e3c0  Add cue-sheet audio track extraction
7adc6b0  Add exe TLSH-distance ranking (web)
b4f2386  Add web audio-Jaccard similarity query
88c52ea  Add Tier-5 exe binary fingerprinting
19241d9  Add audio chroma fingerprinting (Tier 4)
8715dda  Add pgvector text-embedding similarity tier
ec8de44  Web service: search, similarity, submissions API
8770fca  Rewrite curator: rust core, web similarity
```

**Done & validated on real discs:**
- **Phase 0** — old code in `old/`; Cargo workspace (`crates/curator-core|cli|gui-win`),
  uv adapter (`ps2exe-adapter/`), `macos/`, `web/`. Rust pinned to `stable` via
  `rust-toolchain.toml` (1.77 was too old for current crates).
- **Phase 1** — desktop pipeline: Rust image hash → uv/ps2exe adapter (canonical JSON +
  NDJSON progress) → composites + structural + Tier-3 chunk sketch + tree → DAT/JSON →
  sha256 cache → SQLite catalog → `export` (JSONL). Live `indicatif` progress.
  **Nested archive→disc recursion** (zip/7z) works.
- **Fingerprint tiers** (all captured in the one pass): T1 content-id (`content_hash`,
  `filtered_content_hash`), T2 whole-file set, T3 FastCDC+blake3 chunks → MinHash
  sketch + `.chunks` sidecar, T4 audio (chroma sub-fp sets; multi-bin **and** `.cue`
  single-bin), T5 exe (TLSH + imphash). Self-contained audio/TLSH algos (numpy/JS) —
  no libchromaprint/libtlsh.
- **Phase 4 web** — Next 16 / React 19 / Tailwind 4 / TS. `web/db/schema.sql` (pgvector
  + pg_trgm + intarray), TS ingester (`scripts/ingest.ts`), API routes
  (`/api/search`, `/api/similarity`, `/api/submissions[/:sha256]`), search UI.
  Similarity fuses T1/T2/T3 + audio-Jaccard + exe-imphash + exe-TLSH-distance +
  pgvector text embedding (all-MiniLM-L6-v2). Validated: USA↔Alt 34/34 audio @1.0;
  EU↔JP 8 shared tracks (diff content); text-embed lineage 0.80 vs unrelated 0.43;
  JS TLSH diff == py-tlsh (0/14/310).
- **Phase 2 (macOS)** — `ps2exe-adapter/bundle.sh` → self-contained bundle (standalone
  CPython 3.10 + locked deps + ps2exe src + bundled `unrar` + launcher), ~14 MB tar.
  Rust CLI runs it via `--adapter-bin`/`CURATOR_ADAPTER_BIN` with no uv/dev-python.

**Remaining:**
- **Phase 3 GUIs** — UniFFI export from core, SwiftUI (macOS) + windows-rs. Not started
  (can't be run/validated headless).
- Windows bundle; macOS codesign/notarization; native-arm64 `unrar`/`7zz`.
- Web: richer UI (build detail / similarity browse), submission moderation.
- Skipped: image pHash (validated algo, ~0 yield on retro discs — native formats).
- Audio fp is alignment-sensitive (matches identical audio 1.0, same-song-diff-master
  ~0.5); offset-tolerant matching is future work.

**Gotchas / constraints (resume-critical):**
- **Python 3.10 only** — pathlab uses `pathlib._Accessor`, removed in 3.11.
- **pycdlib pinned 1.14** — 1.16 breaks ps2exe's patches (empty directories).
- ps2exe's manifest is incomplete — adapter adds `psutil`, `bitarray`, `inflate64`,
  plus `fastcdc`,`blake3`,`py-tlsh` for our tiers.
- ps2exe `utils/archives.py` requires a **7z/unrar tool at import**; mac fallback ships
  none → bundle provides `unrar`.
- `pyisotools` pulls **PySide6 (~1.1 GB)** + pyinstaller/pylint — bundle prunes them
  (keep chardet/requests etc.; pyisotools imports chardet at runtime).
- uv-managed CPython is locked down — bundle bootstraps pip via `get-pip.py`.
- Postgres dev DB `curator_test`: `pg_trgm`,`vector`(0.8),`intarray` available; **no
  smlar** (use intarray `&&` + JS Jaccard). Server was on :3001 in dev (:3000 taken).
- `lib/ps2exe` submodule has local uncommitted edits; parent commits do **not** bump it.
- `builds/` (7.8 GB sample discs) and `ps2exe-adapter/dist/` are gitignored.

**Resume commands:**
```sh
cd ps2exe-adapter && uv sync && cd ..                 # adapter dev env
cargo run -p curator-cli -- --adapter-dir "$PWD/ps2exe-adapter" analyze <img>
cd web && npm install && createdb curator && psql curator -f db/schema.sql
DATABASE_URL=postgres:///curator npm run ingest -- builds.jsonl   # then npm run dev
sh ps2exe-adapter/bundle.sh                            # build the self-contained bundle
```

## Decisions (locked)

| Topic | Decision |
|---|---|
| Rust ↔ ps2exe | Subprocess: Rust spawns a uv-managed Python **adapter** that calls ps2exe and emits canonical JSON on stdout. Rust never imports Python. |
| ps2exe packaging | Bundled via **uv** (uv-managed standalone Python + locked deps). |
| Windows GUI | **windows-rs**, native, calls `curator-core` directly in-process. |
| macOS GUI | **SwiftUI**, calls `curator-core` over a **UniFFI** C-ABI bridge. |
| CLI | Pure Rust, runs core directly, output to stdout or file. |
| Local DB | **SQLite** (rusqlite/sqlx), single file in the user data dir. |
| Cache key | **Content sha256** — file read once to hash; cached result keyed by sha256. |
| Web search | Postgres **tsvector FTS + pg_trgm** (filenames/hashes) **+ pgvector** ("similar builds" via file-tree embedding). |
| Schema | One versioned canonical schema = serde types in `curator-core`. Adapter emits raw JSON → core normalizes → canonical JSON + XML DAT. |

## Reality of the Rust/Python split

ps2exe is Python and does the hard part (filesystem parsing, decryption for
Wii/PS3/Xbox, per-file extraction). That stays in Python. **Everything else is Rust:**
orchestration, sha256-keyed cache, local build DB, canonical-schema normalization,
XML-DAT + JSON rendering, pretty-printing models, and all three front-ends.

## Repository layout

```
old/                        # entire current codebase moved here (step 0)
crates/
  curator-core/             # lib: schema, orchestrator, cache, SQLite DB, DAT/JSON render, UniFFI exports
  curator-cli/              # bin: thin Rust CLI over core
  curator-gui-win/          # windows-rs app (Windows only)
ps2exe-adapter/             # Python pkg: calls ps2exe, emits canonical-raw JSON; uv-managed
  pyproject.toml            # uv project; depends on ps2exe (git/vendored) + native deps
macos/                      # SwiftUI app + generated UniFFI Swift bindings
web/                        # Next.js + Postgres (pgvector) ingester + searchable UI
lib/ps2exe/                 # submodule, pinned to latest
Cargo.toml                  # workspace
```

## The adapter contract (Rust ↔ Python)

- Invocation: `uv run curator-adapter analyze --path <file> [--no-checksums]`
- Output: the final canonical-raw JSON document on **stdout**; **NDJSON progress
  events on stderr** streamed during the run (see Progress reporting).
- Adapter responsibilities: open via ps2exe `IsoProcessorFactory`, detect system,
  walk the tree, extract per-file md5/sha1/sha256 + dates/sizes, emit volume/header
  metadata. **No formatting, no DB** — just raw structured JSON + progress events.
- Core responsibilities: compute the image-level sha256 (its cache key), normalize
  adapter JSON into the canonical schema, render XML DAT + canonical JSON, store both
  in the user data dir + index row in SQLite, and re-emit progress to the front-end.

## Progress reporting

Two tiers:

1. **Overall / batch** — owned by `curator-core`. When opening a folder or multiple
   files, core knows "file N of M" and emits a top-level determinate bar itself. No
   ps2exe involvement.
2. **Intra-file** — relayed from ps2exe. The adapter passes a **custom duck-typed
   "manager"** into the processors and `ArchiveWrapper` in place of
   `enlighten.get_manager()`. It emulates the minimal enlighten surface ps2exe uses
   (`manager.counter(total=, desc=, unit=, ...)` → a counter exposing `.update(incr,
   **fields)`). Instead of drawing terminal bars, each call emits an event:
   - byte-level hashing (`HashProgressWrapper.update(len(data))`) → fine-grained
     per-file progress;
   - archive-entry iteration (`ArchiveWrapper`'s `file_name` counter) → per-entry
     progress; nested archives just open more counters.

**Event protocol (NDJSON on the adapter's stderr):**
```
{"ev":"counter_open","id":7,"label":"Hashing 0.BIN","unit":"B","total":328892}
{"ev":"progress","id":7,"count":131072}          # throttled: ~every 50ms / few %
{"ev":"counter_close","id":7}
```
- `total: null` ⇒ indeterminate (spinner) for unknown-size phases.
- Active counters form a flat set keyed by `id`; nesting is implicit (multiple open
  at once). Front-ends render all open counters as a small stack of bars under the
  batch bar.
- **Throttling happens in the adapter** so byte-level updates don't flood the pipe.

**Plumbing to front-ends:**
- Core parses adapter stderr line-by-line as it streams, merges with its own batch
  counter, and pushes to a `ProgressObserver` (a UniFFI callback interface).
- macOS SwiftUI: observer updates `@Published`/`@Observable` state on the main actor
  → native `ProgressView`s.
- Windows windows-rs: observer marshals to the UI thread → native `ProgressBar`s.
- CLI: same observer rendered with `indicatif` — progress comes for free.

**Cancellation** pairs with progress: core can kill the adapter subprocess and stop
the batch loop; the observer exposes a cancel signal the GUI "Cancel" button trips.

## Canonical schema (sketch, owned by curator-core)

```
Build {
  schema_version, image{ name, size, md5, sha1, sha256 },
  info{ system, system_identifier, header{...}, volume{...}, exe{...}, disc_type },
  contents: Node tree (Dir{name,date,size,children} | File{name,date,size,md5,sha1,sha256,unreadable?})
}
```
Rendered two ways: **XML DAT** (Redump/No-Intro `<datafile>` style) and **JSON**
(the web interchange + GUI viewer source). Both stored at
`<userdata>/cache/<sha256>.{xml,json}`.

## User data dir & cache flow

- Dirs: `~/Library/Application Support/curator` (mac), `%APPDATA%\curator` (win),
  XDG on Linux (CLI). `directories`/`dirs` crate.
- Open → read+sha256 the file → if `<sha256>.json` exists, load it (skip adapter);
  else run adapter, normalize, write json+xml, upsert SQLite. Batch/folder open
  loops this over every image found.

## Folder semantics

Opening a folder: recursively scan and treat **each disc image/archive as its own
build** (batch → accumulates into the local DB). If the folder contains no
recognizable images, fall back to cataloging the folder itself as a filesystem.

## Phases

**Phase 0 — Move & scaffold**
- Move all current code into `old/`. Init Cargo workspace + empty crates.
- Pin `lib/ps2exe` submodule to latest; stand up `ps2exe-adapter/` as a uv project.

**Phase 1 — Adapter + core (CLI-first, the spine)**
- Write `ps2exe-adapter`: emit canonical-raw JSON on stdout + NDJSON progress on
  stderr via the duck-typed enlighten manager. Verify against `builds/` samples
  (Saturn, Sega CD, PSX).
- `curator-core`: schema types, adapter subprocess driver (streams + parses stderr
  progress), `ProgressObserver` trait, batch counter, sha256 cache, SQLite schema +
  upsert, XML-DAT + JSON renderers, cancellation.
- `curator-cli`: `analyze <paths…> [--format xml|json] [--out] [--no-checksums]`
  with `indicatif` progress rendered from the observer.
  **Milestone: CLI produces a correct DAT for a sample disc with live progress,
  cached on re-run.**

**Phase 2 — uv bundling**
- Reproducible bundle: uv standalone Python + locked deps, on macOS *and* Windows.
- Resolve native-dep sharp edges: `libarchive`, `unrar` (license!), `pycryptodome`,
  `numpy`, `pefile`. Prototype early — this is the top risk.

**Phase 3 — GUI shells**
- `curator-core` UniFFI exports: open, analyze, get-tree, get-details, get-doc,
  plus the `ProgressObserver` callback interface and a `cancel()` handle.
- macOS SwiftUI: tree sidebar → detail pane → native XML/JSON pretty-viewer; batch
  bar + stacked intra-file bars driven by the observer; Cancel button.
- Windows windows-rs: same UX with native TreeView, text view, and `ProgressBar`s.
- Both drive batch open → local DB grows.
- **Similar builds:** "Find similar" submits the build's payload (file-hash set +
  text doc + structural features), keyed by **sha256**, to `POST /similarity`; the
  server logs the check by sha256 and returns ranked neighbors, which the GUI renders
  and **caches locally** (`similarity_check` row). Re-opening shows the cached result;
  a **Re-check** button re-queries by the same sha256 and refreshes it. The build list
  gets an **optional column** (checked? / date / match count / submission status).
  Read-only; needs connectivity; degrades gracefully offline.
- **Submit build (contribute):** per checked build. First-ever submit prompts for a
  **nickname** (persistent contributor handle, stored once, editable in settings);
  thereafter reused silently. Submitting enqueues the canonical build JSON in a
  **local outbox** that uploads to the server submission queue; status (queued →
  uploaded → accepted/rejected) syncs back and shows in the list column.

**Phase 3.5 — Export bridge (bulk contribute path)**
- `curator export --out builds.json[l]`: dump the local SQLite catalog to a JSON
  bundle (one canonical build record each — no precomputed vectors; the server
  derives all indexes). Bulk sibling of the GUI's per-build submit; the web ingester
  only ever reads these bundles.

**Phase 4 — Web (listing + similarity service)**
- Next.js app + Postgres. Ingester loads exported JSON bundles and builds indexes.
- **Search indexes:** `tsvector` + `pg_trgm` for filename FTS/fuzzy; btree for
  exact/prefix hash lookup.
- **Similarity indexes:** GIN over each build's `int[]` file-hash-ID set (smlar /
  array ops) for content overlap; pgvector (cosine/HNSW) for the text embedding.
- **Similarity API** (`POST /similarity`): read-only. Body = sha256 + the query
  build's file-hash set + a text doc (title + filename corpus) + structural features.
  Server **logs the check by sha256**, computes content overlap (GIN/smlar), embeds
  the text doc with its own model and runs pgvector ANN, blends structural features,
  **fuses** the rankings, and returns ranked neighbors. The submitted build is **not**
  ingested by this call.
- **Submissions API** (`POST /submissions`): body = sha256 + nickname + canonical
  build JSON. Server dedups by sha256 and enqueues into a moderation/ingest queue;
  `GET /submissions/{sha256}` returns status for the client to sync. Accepted
  submissions flow into the same ingester as the bulk export bundles.
- Public searchable listing: filename FTS/fuzzy, exact hash lookup, similarity browse.

## Similarity (for "similar builds") — a web service

Goal = **build lineage**: redumps, regional variants, successive prototypes of the
same game. Computed **server-side only** and delivered via the `/similarity` API.
The GUI submits a build's payload and renders the response; it never holds the index
or the embedding model. (Offline ⇒ no similarity; details/tree still work.)

**Layered tiers, all from one read of the file** (see Build record). All active in
v1. Cheapest/most precise first; fused at query time:

| Tier | Built from | Answers | Index |
|---|---|---|---|
| 1. Content identity | image sha256 + `content_hash` / `filtered_content_hash` | "same dump / same contents, different metadata" | equality |
| 2. Identical-file overlap | whole-file hash **set** (`int[]`) | "shares identical files" | GIN / `smlar` Jaccard |
| 3. Similar-content overlap | **FastCDC chunk-hash set** → weighted-MinHash sketch | "shares *near*-identical & partial files" | LSH banding (GIN) |
| 4. Perceptual media | **pHash** (images), **Chromaprint** (audio) per asset | "same assets, re-encoded / different bitrate" | pHash Hamming (BK-tree/LSH), Chromaprint match |
| 5. Exe binary similarity | **TLSH + imphash** (+ func hashes) of the boot exe | "same program, recompiled / patched" | imphash equality; TLSH forest (HAC-T) |

Plus two cross-cutting signals folded into the fusion:
- **Text embedding** — title + maker + system + filename corpus via a local open model
  (e.g. `bge-small-en`, 384-dim), pgvector cosine/HNSW. Recovers **recompiled** builds.
- **Structural** — system, log file-count/size, depth, ext histogram; plain columns,
  tiebreaker.

And an on-demand **diff view**: per-file chunk lists + exe/media fingerprints →
"what changed between A and B" (pairwise, not a ranking index).

**Adopted refinements:** Tier-3 uses **weighted MinHash** (BagMinHash/ProbMinHash) so
sketches honor chunk size + IDF; a server-side **corpus chunk-IDF table** formalizes
"stop-chunks" (down-weights ubiquitous padding/headers), the chunk-level analogue of
stop-file pruning.

Identity/identical-file (Tiers 1–2) stay in btree/GIN/`smlar`; chunk similarity
(Tier 3) in LSH-banded GIN; media/exe (Tiers 4–5) in their own indexes; pgvector
hosts **only** the text embedding. **Evaluate LZJD** as an alternative Tier-3 engine;
keep **NCD** as an offline quality baseline.

## Similarity checks & contributor submissions

**Identity = sha256** everywhere (same key as the analysis cache). No separate opaque
ID. Content-stable, so checks/submissions dedup globally across machines.

Local SQLite additions (alongside the build cache index):
- `settings.nickname` — persistent contributor handle, captured on first submit.
- `similarity_check(sha256 PK, checked_at, refreshed_at, result_json)` — the cached
  ranked response; powers "show previous result" and the build-list column.
- `submission(sha256 PK, nickname, status, queued_at, uploaded_at)` — local outbox +
  synced server status (queued → uploaded → accepted/rejected).

Server-side: similarity requests logged by sha256; submissions queued by sha256 into
moderation/ingest. Endpoints: `POST /similarity`, `POST /submissions`,
`GET /submissions/{sha256}`.

## Build record — final output shape & size budget

**Principle:** the single pass over the (multi-GB) image is the *only* access to its
bytes. The persisted record must be fully **image-independent** — every downstream op
(DAT render, all four similarity tiers, submission, re-sketching) derives from it
alone. Capture everything cheap *now*, including inputs for the deferred media/exe
tiers (irrecoverable later). Only a CDC-param change (`fingerprint_version`) forces a
re-scan.

**Physical split:**
- **Core record** (`<sha256>.json` + rendered `<sha256>.xml` DAT) — always kept:
  identity, info, composites, structural, text_doc, contents tree, media/exe
  fingerprints, and the weighted-MinHash sketch. Tens of KB to ~0.7 MB.
- **Chunk sidecar** (`<sha256>.chunks`, compact binary) — per-file `(hash64, len)`
  lists. **Prunable** after contribution (the server is the durable chunk store and
  the only consumer of raw chunks — for IDF re-weighting and Tier-4 diff). ~0.6 MB
  per 4 GB disc.

```
BuildRecord {
  record_schema_version, fingerprint_profile   // e.g. "v1" — see Schema & fingerprint versioning
  image: { name, size, md5, sha1, sha256 }     // sha256 = primary key/identity
  info:  { system, header{...}, volume{...}, exe{filename,date}, disc_type }
  composites: { content_hash, filtered_content_hash,                 // Tier-1
                hash_exe, most_recent_file{path,date,hash}, incomplete_files }
  structural: { system, file_count, total_size, max_depth, ext_histogram }
  text_doc:   "<title> <maker> <system> <filename/path corpus>"      // server embeds
  contents:   Node[]   // File{name,date,size,md5,sha1,sha256,unreadable} | Dir{...}
  media:      [ { path, kind, phash|chromaprint } ]                  // Tier-4 (active)
  exe_fp:     { tlsh, imphash, func_hashes? }                        // Tier-5 (active)
  sketch:     { kind:"weighted-minhash", k, seed, values[] }         // ~2 KB, Tier-3
  // chunk sidecar (separate file): files:[ {path, chunks:[[hash64,len]]} ]  // Tier-3/4
}
```

**Content fingerprints** (digest over per-file content hashes, sorted by hash ⇒
independent of filenames, layout, order, and image container):
- `content_hash` — over **all** files; strict (every file, incl. junk, must match).
- `filtered_content_hash` — **excluding ignored files** (`.nfo`/`.diz`/scene junk +
  per-system ignores); tolerant of cosmetic differences. These are Tier-1 identity and
  the cross-machine "same contents, different metadata" signal (image sha256 stays the
  primary key). Replaces ps2exe's path-sorted `all_files_hash` variants (dropped).

**Size levers (keep it < 2 MB):**
- **64-bit truncated chunk hashes** — used for similarity set-membership, not integrity;
  collision noise is negligible (~5e-10 within a disc; a handful corpus-wide). Halves
  the sidecar.
- **64 KB average chunk** — one changed chunk per edit either way; halves again.
  (Sensitivity↔footprint knob.)
- **Media/exe stored as fingerprints, never raw bytes** — pHash ~8 B/image,
  Chromaprint reduced ~KB/track, exe = TLSH+imphash (PS3/Xbox exes are multi-MB raw).
- **Sketch always; raw chunks prunable** — check path submits the ~2 KB sketch;
  contribute path uploads raw chunks once for the server to keep.

**Budget (~4 GB disc):** core record 0.1–0.7 MB (tree-dominated, scales with file
count) + chunks ~0.6 MB + media/exe/sketch <20 KB ⇒ **~0.8–1.4 MB**; **~0.1–0.7 MB
after pruning chunks**. (If the tree ever dominates, move it to its own sidecar to
keep the core tiny.)

**Two paths reuse the record:**
- *Similarity check* (read-only): submit sketch + text_doc + structural + file-hash set.
- *Contribute/ingest*: upload core + raw chunks once; server builds the corpus
  chunk-IDF table, an IDF-weighted sketch, and retains chunks for Tier-4 diff.

## Schema & fingerprint versioning

Two independent axes:
- **`record_schema_version`** — serialization shape (which fields exist). Ordinary
  additive/serde migrations.
- **`fingerprint_profile`** (`v1`, `v2`, …) — the algorithm manifest (below).

**Component registry** (`curator-core`, immutable once shipped). Every fingerprint
component is independently versioned and declares **its source** — what it's computed
from — which determines migration cost:

```
Component { id, version, params, source }
source ∈ RawBytes        // needs the original image → RE-SCAN only
         FromFileHashes  // derivable from stored per-file hashes
         FromChunkSet    // derivable from the chunk sidecar
         FromTree | FromTextDoc | FromCorpus   // derivable from the stored record/corpus
```
e.g. `image_hashes`/`per_file_hashes`/`chunking`/`phash`/`chromaprint`/`exe_fp` =
**RawBytes**; `content_hash`←FromFileHashes; `minhash`←FromChunkSet;
`structural`←FromTree; `text_embed`←FromTextDoc; IDF-weighted sketch←FromCorpus.

A **Profile** (`v1`) is a frozen manifest pinning each component to a version. The
record stores the profile tag + a manifest hash (integrity). **Profiles are immutable**
— never redefine `v1`, only add `v2`.

**Migration is computed, not hand-listed.** `diff(profile_old, profile_new)` →
for each changed component, partition by `source`:
- **Derivable** → ingest-side recompute from stored records (no image); converges the
  whole corpus. Cheap, global, desktop untouched. (Optional custom migration fn.)
- **RawBytes** → can't recompute without the image; mark records' component
  frozen/stale, degrade that tier for them, and **segment the index by component
  version** (different-version chunk sets / pHashes aren't comparable).

**Consequence:** bumping a RawBytes component **fragments the similarity corpus** into
version classes — effectively permanent, since images are gone. So: get RawBytes
components right early and bump them *rarely*; bump derivable components freely.

Wiring: the adapter is told which profile to compute and tags its output; the ingester
reads the profile, runs derivable recomputes, and segments RawBytes indexes by version.

## Top risks

1. **Native Python deps in the bundle** (unrar licensing, libarchive, compiled
   wheels, macOS notarization of bundled interpreter). Prototype in Phase 2, not last.
2. **Two native UIs** — mitigated by a UI-agnostic core; SwiftUI+UniFFI and
   windows-rs share all logic.
3. **ps2exe is Poetry/CSV today** — the adapter (new code) is the JSON boundary; no
   ps2exe internals leak into Rust.
4. **Similarity quality** — exact set sim is faithful by construction; main risk is
   popular-file posting-list blowup (mitigated by stop-file pruning). Validate
   rankings against the `builds/` Sonic-CD prototype set (known lineage).
5. **Similarity availability** — it's a network service; the GUI must degrade
   gracefully offline.

## Resolved

- **Linux GUI:** deprioritized — future work. Core stays UI-agnostic; Linux ships the
  CLI only for now.
- **Export bridge:** yes — `curator export` → JSON bundle is the desktop→web
  *contribute* feed (Phase 3.5).
- **Similarity identity = sha256** (no separate random ID); persistent contributor
  nickname (prompt once); manual Re-check that re-queries by sha256.
- **Submissions:** local outbox → `POST /submissions` (dedup by sha256) → server
  moderation/ingest queue; status synced back to the GUI.
- **Similarity = web service.** Layered tiers (identity / identical-file /
  chunk-similar / diff) + text embedding + structural, fused server-side; GUI submits
  to `POST /similarity` (read-only) and renders. Tier-3 = FastCDC chunks + **weighted
  MinHash** + **corpus chunk-IDF**. Evaluate LZJD; NCD as baseline.
- **Capture everything in one pass** including deferred-tier inputs (pHash/Chromaprint
  for media, TLSH+imphash for the exe) — irrecoverable once the image is gone.
- **Build record is image-independent and < ~2 MB** (64-bit chunk hashes, 64 KB avg
  chunk, fingerprints-not-raw-bytes, prunable chunk sidecar). See Build record.
- **Versioning:** `record_schema_version` (shape) + immutable `fingerprint_profile`
  manifests; each component tags its recompute `source`, so migration is computed from
  a manifest diff. RawBytes bumps fragment the corpus (rare); derivable bumps are free.

## Open items to confirm

- Submission moderation: who reviews the server queue, and accept/reject criteria.
```
