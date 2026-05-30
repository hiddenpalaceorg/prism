# curator-gui-win

Native **Windows** GUI over `curator-core` using **windows-rs**. The core is called
directly in-process (same language); progress is marshaled to the UI thread.

**Status:** scaffold — to be built. Excluded from the workspace (`Cargo.toml`
`exclude`) so non-Windows builds skip it; build explicitly on Windows.

## Plan

- Win32/WinUI window with a native `TreeView` (filesystem tree), a detail pane, and a
  text view for the pretty-printed XML/JSON.
- A `ProgressObserver` impl that `PostMessage`s to the UI thread → native
  `ProgressBar`s (batch + stacked intra-file); a Cancel button trips the cancel handle.
- "Find similar" → `POST /similarity`; "Submit build" → nickname prompt + outbox.
- Bundles the uv-managed adapter (Phase 2).

Shares all logic with the macOS app via `curator-core`; only the shell differs.
