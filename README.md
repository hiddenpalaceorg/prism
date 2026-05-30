# Curator

Disc-image analysis and cataloging for game preservation, rebuilt from scratch.
A Rust core drives the Python **ps2exe** engine to parse images/containers, produces
a checksummed DAT + JSON per disc, builds a local catalog, and feeds a web service
for searchable listings and "similar builds" discovery.

See [`PLAN.md`](PLAN.md) for the full design and rationale.

## Layout

```
crates/curator-core/   Rust engine: schema, adapter driver, fingerprints, cache, SQLite, DAT/JSON
crates/curator-cli/    Rust CLI (`curator`)
crates/curator-ffi/    UniFFI bridge over the core (static lib for native GUIs)
crates/curator-gui-win/ Windows GUI (windows-rs)         — scaffold
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
| Phase 1 — adapter → core → CLI (analyze, cache, catalog, export) | ✅ working |
| ↳ nested archive→disc recursion (bin/cue inside zip/7z) | ✅ working |
| ↳ Tier-3 chunk fingerprint (FastCDC + MinHash sketch + sidecar) | ✅ working & validated |
| ↳ Tier-4 audio fingerprint (chroma sub-fp sets, numpy; multi-bin + .cue single-bin) | ✅ validated (cross-build EU↔JP) |
| ↳ Tier-5 exe binary fingerprint (TLSH + imphash; web imphash query) | ✅ built & validated |
| ↳ web audio-Jaccard query (shared CDDA tracks) | ✅ built & validated |
| ↳ exe TLSH-distance ranking (web, validated vs py-tlsh) | ✅ built & validated |
| ↳ image pHash | ⬜ skipped (validated algorithm; ~0 yield on retro discs) |
| Phase 4 — web (Next 16/TS/Tailwind): schema, ingester, search/similarity/submission API, search UI | ✅ built & validated |
| ↳ text-embedding tier (all-MiniLM-L6-v2 → pgvector cosine) | ✅ built & validated |
| ↳ richer UI, submission moderation | ⬜ |
| Phase 2 — self-contained macOS adapter bundle (standalone Python + deps + unrar) | ✅ built & validated |
| ↳ Windows bundle, macOS codesign/notarize, native-arm64 unrar | ⬜ |
| Phase 3 — UniFFI bridge (`curator-ffi`) + SwiftUI macOS app (tree, details, XML/JSON, progress, cancel) | ✅ built & validated |
| ↳ macOS GUI: embedded self-contained adapter (no env/dev-tools) | ✅ built & validated |
| ↳ macOS GUI: Find-Similar + Submit wired to web API | ✅ built & validated (live) |
| ↳ macOS GUI: codesign/notarize, drag-and-drop, recent builds | ⬜ |
| ↳ Windows GUI (windows-rs) | ⬜ scaffold |

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

# catalog stats / export the catalog for the web ingester
cargo run -p curator-cli -- stats
cargo run -p curator-cli -- export -o builds.jsonl
```

Re-analyzing a known image is served from the sha256 cache. Cache + catalog live in
the platform user-data dir (override with `--data-dir`).

## Bundling (no dev toolchain)

`sh ps2exe-adapter/bundle.sh` builds a self-contained adapter under
`ps2exe-adapter/dist/bundle/`: a relocatable standalone CPython 3.10 with the locked
deps, the adapter + ps2exe source, a bundled `unrar`, and a `curator-adapter` launcher.
The CLI/GUI uses it with no uv/Python/dev-tools present:

```sh
curator --adapter-bin /path/to/bundle/curator-adapter analyze image.bin   # or CURATOR_ADAPTER_BIN
```

Remaining for a shippable app: a Windows bundle, macOS code-signing/notarization, and a
native-arm64 `unrar`/`7zz` (the bundled `unrar` is x86_64, runs via Rosetta). `unrar`
carries the unRAR license (extraction-only redistribution).

## Notes

- The adapter pins **pycdlib 1.14** and **Python 3.10** — required by ps2exe's patches
  and `pathlab` respectively.
- ps2exe's manifest is incomplete; the adapter declares the real runtime deps
  (`psutil`, `bitarray`, `inflate64`, …).
