# curator-gui-win

Native **Windows** GUI over `curator-core` using **windows-rs**. The core is called
directly in-process (same language, no FFI); analysis runs on a worker thread and
progress is marshaled to the UI thread via `PostMessageW`.

Excluded from the root workspace so non-Windows `cargo build` skips it.

## What's implemented

- Classic Win32 window: a `SysTreeView32` of the analyzed filesystem on the left, a
  read-only multiline edit with the DAT/XML on the right, a progress bar + status bar.
- **File ▸ Open Image…** (`GetOpenFileNameW`), **Open Folder…** (`SHBrowseForFolderW`),
  and **Open Recent** (the local library; reopens from cache, no re-analysis).
- **Drag-and-drop** a file/folder onto the window (the panes are subclassed to forward
  `WM_DROPFILES`).
- Adapter resolution: `CURATOR_ADAPTER_BIN` → `adapter\curator-adapter*` next to the exe
  → `CURATOR_ADAPTER_DIR` → the dev `ps2exe-adapter` uv project.
- A `ProgressObserver` that queues events and pokes the window → the progress bar tracks
  image hashing and intra-archive counters; the status bar shows batch/messages.
- **Analysis ▸ Cancel** trips the shared cancel flag (core unwinds, subprocess killed).
- On completion the tree is populated recursively and the XML shown.
- **Analysis ▸ Find Similar** — POSTs the canonical record to `/api/similarity` (native
  **WinHTTP**) and lists tiered neighbors in the document pane.
- **Analysis ▸ Submit Build…** — a small modal nickname prompt, then POSTs
  `{nickname, record}` to `/api/submissions`. Web base URL from `CURATOR_WEB_URL`
  (default `http://localhost:3001`). Both calls run on a worker thread.

## Build / check

On Windows (MSVC), the normal path:

```sh
cargo build --manifest-path crates/curator-gui-win/Cargo.toml          # → curator-gui-win.exe
```

Cross-compile-checked from macOS/Linux against the GNU target (needs the
`x86_64-pc-windows-gnu` rustc target and a mingw-w64 cross toolchain for
`rusqlite`'s bundled SQLite):

```sh
rustup target add x86_64-pc-windows-gnu
brew install mingw-w64                      # or your distro's mingw-w64
export CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc
export AR_x86_64_pc_windows_gnu=x86_64-w64-mingw32-ar
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
cargo build --manifest-path crates/curator-gui-win/Cargo.toml --target x86_64-pc-windows-gnu
# → target/x86_64-pc-windows-gnu/debug/curator-gui-win.exe  (PE32+ GUI executable)
```

## Adapter binary

The adapter is a PyInstaller one-file build: `uv run --group dev pyinstaller
curator-adapter.spec` (run in `ps2exe-adapter\`, uv on PATH) freezes
`dist\curator-adapter.exe`. CI builds it, then builds the GUI with
`CURATOR_ADAPTER_EXE` pointing at it, so `build.rs` **embeds the adapter inside
`curator-gui-win.exe`** — the shipped download is a single self-contained file that
extracts the adapter to `%TEMP%\curator\` on first launch.

Resolution order at runtime: `CURATOR_ADAPTER_BIN` → `adapter\curator-adapter*` beside
the exe → the embedded copy → `CURATOR_ADAPTER_DIR` → the dev `ps2exe-adapter` uv project.
So a plain `cargo build` (no `CURATOR_ADAPTER_EXE`) still works for dev via the sibling /
dir / uv fallbacks. Code-signing is out of scope.

Shares all logic with the macOS app via `curator-core`; only the shell differs.
