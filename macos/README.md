# Curator — macOS GUI

Native **SwiftUI** app over `curator-core`, bridged with **UniFFI** (C-ABI). The Rust
core stays UI-agnostic; this app renders the tree, details, the pretty XML/JSON
viewer, and progress.

**Status:** scaffold — to be built.

## Plan

1. Add a `uniffi` feature to `curator-core` exporting: `analyze`, `getTree`,
   `getDetails`, `getDocument(xml|json)`, `export`, a `ProgressObserver` callback
   interface, and a `cancel()` handle. Generate the Swift bindings with
   `uniffi-bindgen` and build the core as a static lib + xcframework.
2. SwiftUI app:
   - Sidebar: `OutlineGroup` over the filesystem tree.
   - Detail pane: selected file's metadata + hashes.
   - Document viewer: native pretty-printed XML/JSON.
   - Progress: batch bar + stacked intra-file bars from the observer (on the main
     actor); a Cancel button trips the cancel handle.
   - "Find similar" → `POST /similarity` (file-hash set + text doc + structural),
     render ranked neighbors; "Submit build" → nickname prompt + outbox.

## Notes

- Similarity is a network service (read-only); degrade gracefully offline.
- The app bundles the uv-managed adapter (Phase 2) so it can analyze without a dev
  toolchain installed.
