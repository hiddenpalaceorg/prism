# Prism for Windows (WinUI 3)

Native Windows shell over `prism-core`, replacing the classic Win32 app in
`crates/prism-win`. C# + WinUI 3 (Windows App SDK), calling the Rust core
in-process through UniFFI-generated C# bindings plus two plain C exports
(`prism_tga_to_bmp`, `prism_cli_run`) from `crates/prism-ffi`.

## Layout

- `PrismWin/`: the app. `Generated/` (gitignored) holds the UniFFI C#
  bindings, regenerated from the built DLL so binding checksums always match
  the Rust side.
- `build.ps1`: Rust dylib -> bindings -> `dotnet build` in one step.

## Building

On Windows, from the repo root:

```powershell
pwsh windows/build.ps1 -Run
```

or step by step:

```powershell
cargo build -p prism-ffi --release
uniffi-bindgen-cs --library target/release/prism_ffi.dll --out-dir windows/PrismWin/Generated
dotnet build windows/PrismWin/PrismWin.csproj -c Release -p:Platform=x64
```

CI publishes a single self-extracting exe (app, `prism_ffi.dll`, and the
frozen Python adapter bundled, extracted to a per-version temp dir at first
launch) as the `PrismWin-winui` artifact. Locally, `dotnet build` keeps the
plain folder layout for fast iteration. Reproduce the CI exe with:

```powershell
dotnet publish windows/PrismWin/PrismWin.csproj -c Release -r win-x64 -p:Platform=x64 -p:PublishSingleFile=true --self-contained true -o windows/dist/PrismWin
```

## Behavior notes

- `PrismWin.exe --cli <command...>` runs the shared prism CLI in-process,
  like `prism-win --cli` (GUI-subsystem exe: an interactive prompt returns
  immediately; output still reaches the console, redirection works).
- Adapter resolution matches prism-win: `PRISM_ADAPTER_BIN` ->
  `adapter\prism-adapter*` next to the exe -> `PRISM_ADAPTER_DIR` -> the dev
  `ps2exe-adapter` uv project. `PRISM_WEB_URL`, `PRISM_MODERATION_TOKEN`, and
  `PRISM_DATA_DIR` behave as in the other front-ends.
- Text/source/binary assets are never handed to the shell (a `.bat`/`.js`
  from an untrusted disc must not reach anything that executes it); they
  preview in-app, binary as a hex dump. Images, audio, and video open in the
  in-app viewer; documents go to the default app via a staged temp copy.
