# Curator

Disc-image analysis and storing for game preservation, rebuilt from scratch.
A Rust core drives the Python **ps2exe** engine to parse images/containers, produces
a checksummed DAT + JSON per disc, builds a local library, and feeds a web service
for searchable listings and "similar builds" discovery.

## Layout

```
crates/curator-core/   Rust engine: schema, adapter driver, fingerprints, cache, SQLite, DAT/JSON
crates/curator-cli/    Rust CLI (`curator`)
crates/curator-ffi/    UniFFI bridge over the core (static lib for native GUIs)
crates/curator-gui-win/ Windows GUI (windows-rs)         — builds curator-gui-win.exe
ps2exe-adapter/        Python (uv): ps2exe → canonical JSON + NDJSON progress
macos/                 macOS GUI (SwiftUI + UniFFI core) — builds Curator.app
web/                   Next.js + Postgres listing & similarity service — scaffold (schema done)
lib/ps2exe/            ps2exe engine (submodule)
old/                   the previous implementation, archived
builds/                sample disc images for testing
```

## Status

| Area | State |
|---|---|
| Phase 0 — workspace + move old code | ✅ done |
| Phase 1 — adapter → core → CLI (analyze, cache, library, export) | ✅ working |
| ↳ nested archive→disc recursion (bin/cue inside zip/7z) | ✅ working |
| ↳ Chunk fingerprint (FastCDC + MinHash signature + sidecar) | ✅ working & validated |
| ↳ Audio fingerprint (Shazam-style constellation peak-pairs, numpy; offset-tolerant) | ✅ validated (cross-build EU↔JP; offset-robust) |
| ↳ Exe binary fingerprint (TLSH + imphash; web imphash query) | ✅ built & validated |
| ↳ web audio-Jaccard query (shared CDDA tracks) | ✅ built & validated |
| ↳ exe TLSH-distance ranking (web, validated vs py-tlsh) | ✅ built & validated |
| ↳ image pHash | ⬜ skipped (validated algorithm; ~0 yield on retro discs) |
| Phase 4 — web (Next 16/TS/Tailwind): schema, ingester, search/similarity/submission API, search UI | ✅ built & validated |
| ↳ text-embedding tier (all-MiniLM-L6-v2 → pgvector cosine) | ✅ built & validated |
| ↳ build-detail page (`/builds/[sha256]`: details, files, similar) + search links | ✅ built & validated (live) |
| ↳ submission-moderation UI (`/moderate`: list, accept→ingest, reject; `MODERATION_TOKEN`-gated) | ✅ built & validated (live) |
| Phase 2 — self-contained adapter binary (PyInstaller `curator-adapter.spec`; one ≈60 MB file) | ✅ built & validated (macOS run + CI Windows/macOS) |
| ↳ macOS codesign/notarize | ⬜ (signing out of scope) |
| Phase 3 — UniFFI bridge (`curator-ffi`) + SwiftUI macOS app (tree, details, XML/JSON, progress, cancel) | ✅ built & validated |
| ↳ macOS GUI: embedded self-contained adapter (no env/dev-tools) | ✅ built & validated |
| ↳ macOS GUI: Find-Similar + Submit wired to web API (neighbors deep-link to web) | ✅ built & validated (live) |
| ↳ macOS GUI: drag-and-drop + recent-builds list (reopen from cache) | ✅ built & validated |
| ↳ macOS GUI: codesign/notarize | ⬜ |
| Phase 3 — Windows GUI (windows-rs: tree, XML view, progress, cancel, open file/folder) | ✅ built (cross-compiled to a PE32+ .exe) |
| ↳ Windows GUI: Find-Similar + Submit (native WinHTTP → web API) | ✅ built (cross-compiled) |
| ↳ Windows GUI: recent-builds menu, drag-and-drop, adapter-next-to-exe | ✅ built (cross-compiled) |
| ↳ Windows adapter binary (PyInstaller, embedded into a single `curator-gui-win.exe`) | ✅ (built in CI on `windows-latest`) |

## Quick start (CLI)

Requirements: Rust (pinned to stable via `rust-toolchain.toml`), [uv](https://docs.astral.sh/uv/),
and git submodules checked out (`git submodule update --init`).

```sh
# one-time: install the adapter's Python env (uses Python 3.10 — pinned for pathlab)
cd ps2exe-adapter && uv sync && cd ..

# analyze an image → DAT on stdout
cargo run -p curator-cli -- --adapter-dir "$PWD/ps2exe-adapter" analyze path/to/image.bin

# JSON, to a file
cargo run -p curator-cli -- --adapter-dir "$PWD/ps2exe-adapter" analyze image.bin -f json -o out.json

# library stats / export the library for the web ingester
cargo run -p curator-cli -- stats
cargo run -p curator-cli -- export -o builds.jsonl
```

Re-analyzing a known image is served from the sha256 cache. Cache + library live in
the platform user-data dir (override with `--data-dir`).

## Tests

```sh
cargo test --workspace                                              # Rust core/CLI/FFI
cd web && npm test                                                  # tlsh vs py-tlsh + helpers
cd ps2exe-adapter && uv run --with pytest pytest tests/             # audio fingerprint
```

CI (`.github/workflows/ci.yml`) runs all of the above on every push/PR, plus native
Windows and macOS app builds (with the PyInstaller adapter) published as per-commit
downloads, and `tsc --noEmit`.

## Packaging (no dev toolchain)

`cd ps2exe-adapter && uv run --group dev pyinstaller curator-adapter.spec` freezes the
adapter into a single self-contained `dist/curator-adapter` (≈60 MB; `.exe` on Windows):
the locked deps, the adapter + ps2exe source, and the vendored libarchive in one binary.
The CLI/GUI run it with no uv/Python/dev-tools present:

```sh
curator --adapter-bin /path/to/curator-adapter analyze image.bin   # or CURATOR_ADAPTER_BIN
```

CI builds this on Windows and macOS and publishes per-branch downloads: a single
self-contained Windows `.exe` (the adapter embedded, extracted to `%TEMP%` on launch) and
the adapter-embedded macOS `.app` — see `.github/workflows/ci.yml`.
Remaining for a shippable app: macOS code-signing/notarization.

## Building from source on Linux (servers)

For a headless box that builds the library from a local dump collection (no GUI,
no prebuilt artifact), build the CLI from source. `scripts/bootstrap-linux.sh`
takes a bare host to a working `curator` with **no root**: it installs rustup and
uv into the user's home (uv supplies the pinned Python 3.10 and the adapter's
locked deps) and compiles `curator-cli`. The one system dependency is
`libarchive.so`, which ships with virtually every Linux base install.

```sh
git clone --recurse-submodules <repo> curator && cd curator
bash scripts/bootstrap-linux.sh        # idempotent; prints CURATOR_BIN + CURATOR_ADAPTER_DIR
```

To build (or extend) a library from whole dump-set directories and export an
ingestable feed, use `scripts/curator-build-set.sh` — it shards analysis across
CPUs into independent `--data-dir` stores (no SQLite-writer contention), and is
resumable and incremental:

```sh
scripts/curator-build-set.sh analyze --bin target/release/curator \
  --adapter ps2exe-adapter --lib ~/curator-lib/main --jobs 6 -- /path/to/Console-A /path/to/Console-B
scripts/curator-build-set.sh export  --bin target/release/curator \
  --lib ~/curator-lib/main --out feed.jsonl     # ingest with web/scripts/ingest.ts
```

Driving this end-to-end against the remote dump server (sync → bootstrap →
analyze → export → ingest → verify web) is automated by the `remote-library`
skill (`.claude/skills/remote-library`).

## Notes

- The adapter pins **pycdlib 1.14** and **Python 3.10** — required by ps2exe's patches
  and `pathlab` respectively.
- ps2exe's manifest is incomplete; the adapter declares the real runtime deps
  (`psutil`, `bitarray`, `inflate64`, …).
