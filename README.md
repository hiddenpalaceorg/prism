# Curator

Disc-image analysis and storing for game preservation, rebuilt from scratch.
A Rust core drives the Python **ps2exe** engine to parse images/containers, produces
a checksummed DAT + JSON per disc, builds a local library, and feeds a web service
for searchable listings and "similar builds" discovery.

## Layout

```
crates/curator-core/    Rust engine: schema, adapter driver, fingerprints, cache, SQLite, DAT/JSON
crates/curator-cli/     Rust CLI (`curator`)
crates/curator-ffi/     UniFFI bridge over the core (static lib for native GUIs)
crates/curator-gui-win/ Windows GUI (windows-rs)         — builds curator-gui-win.exe
ps2exe-adapter/         Python (uv): ps2exe → canonical JSON + NDJSON progress
macos/                  macOS GUI (SwiftUI + UniFFI core) — builds Curator.app
web/                    Next.js + Postgres listing & similarity service
lib/ps2exe/             ps2exe engine (submodule)
old/                    the previous implementation, archived
```

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

## Notes

- The adapter pins **pycdlib 1.14** and **Python 3.10** — required by ps2exe's patches
  and `pathlab` respectively.
- ps2exe's manifest is incomplete; the adapter declares the real runtime deps
  (`psutil`, `bitarray`, `inflate64`, …).
