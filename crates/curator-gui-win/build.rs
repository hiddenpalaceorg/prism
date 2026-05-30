// Optionally embed a prebuilt adapter binary into the exe for single-file distribution.
// Set CURATOR_ADAPTER_EXE=<absolute path to curator-adapter.exe> at build time (CI does
// this) and the GUI extracts it on launch; unset, the GUI resolves the adapter the normal
// way (sibling file / CURATOR_ADAPTER_DIR / uv).
use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=CURATOR_ADAPTER_EXE");
    println!("cargo:rustc-check-cfg=cfg(embed_adapter)");
    if let Ok(path) = env::var("CURATOR_ADAPTER_EXE") {
        if !path.trim().is_empty() {
            println!("cargo:rerun-if-changed={path}");
            println!("cargo:rustc-env=CURATOR_EMBEDDED_ADAPTER={path}");
            println!("cargo:rustc-cfg=embed_adapter");
        }
    }
}
