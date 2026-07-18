# prism-win

Native **Windows** GUI over `prism-core` using **windows-rs**. The core is called
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
- Adapter resolution: `PRISM_ADAPTER_BIN` → `adapter\prism-adapter*` next to the exe
  → `PRISM_ADAPTER_DIR` → the dev `ps2exe-adapter` uv project.
- A `ProgressObserver` that queues events and pokes the window → the progress bar tracks
  image hashing and intra-archive counters; the status bar shows batch/messages.
- **Analysis ▸ Cancel** trips the shared cancel flag (core unwinds, subprocess killed).
- On completion the tree is populated recursively and the XML shown.
- **Analysis ▸ Find Similar** — POSTs the canonical record to `/api/similarity` (native
  **WinHTTP**) and lists tiered neighbors in the document pane.
- **Analysis ▸ Submit Build…** — a small modal nickname prompt, then POSTs
  `{nickname, record}` to `/api/submissions`. Web base URL from `PRISM_WEB_URL`
  (default `https://hiddenpalace.org`). Both calls run on a worker thread.

## CLI mode

`prism-win.exe --cli <command…>` runs the shared prism CLI (the
`prism-cli` crate) instead of opening a window — the full command surface:
`analyze`, `import`, `list`, `systems`, `recent`, `show`, `extract`, `similar`,
`submit`, `export`, `stats`. The process attaches to the launching console (or
allocates one), so output, pipes, and redirection behave normally. Adapter
resolution matches the GUI: `--adapter-bin`/`--adapter-dir` (or their env vars)
first, then the bundled/embedded adapter.

One caveat of a GUI-subsystem exe: an interactive cmd/PowerShell prompt does not
wait for it, so the prompt may return before output finishes. `prism-win
--cli … | more`, redirection, or `start /wait` give the usual synchronous
behavior.

## Build / check

On Windows (MSVC), the normal path:

```sh
cargo build --manifest-path crates/prism-win/Cargo.toml          # → prism-win.exe
```

Cross-compile-checked from macOS/Linux against the GNU target (used during development —
needs the `x86_64-pc-windows-gnu` rustc target and a mingw-w64 cross toolchain for
`rusqlite`'s bundled SQLite):

```sh
rustup target add x86_64-pc-windows-gnu
brew install mingw-w64                      # or your distro's mingw-w64
export CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc
export AR_x86_64_pc_windows_gnu=x86_64-w64-mingw32-ar
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc
cargo build --manifest-path crates/prism-win/Cargo.toml --target x86_64-pc-windows-gnu
# → target/x86_64-pc-windows-gnu/debug/prism-win.exe  (PE32+ GUI executable)
```

## Adapter binary

The adapter is a PyInstaller one-file build: `uv run --group dev pyinstaller
prism-adapter.spec` (run in `ps2exe-adapter\`, uv on PATH) freezes
`dist\prism-adapter.exe`. CI builds it, then builds the GUI with
`PRISM_ADAPTER_EXE` pointing at it, so `build.rs` **embeds the adapter inside
`prism-win.exe`** — the shipped download is a single self-contained file that
extracts the adapter to `%TEMP%\prism\` on first launch.

Resolution order at runtime: `PRISM_ADAPTER_BIN` → `adapter\prism-adapter*` beside
the exe → the embedded copy → `PRISM_ADAPTER_DIR` → the dev `ps2exe-adapter` uv project.
So a plain `cargo build` (no `PRISM_ADAPTER_EXE`) still works for dev via the sibling /
dir / uv fallbacks. Code-signing is out of scope.

Shares all logic with the macOS app via `prism-core`; only the shell differs.
