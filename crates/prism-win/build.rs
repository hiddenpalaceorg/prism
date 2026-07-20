// Optionally embed a prebuilt adapter binary into the exe for single-file distribution.
// Set PRISM_ADAPTER_EXE=<absolute path to prism-adapter.exe> at build time (CI does
// this) and the GUI extracts it on launch; unset, the GUI resolves the adapter the normal
// way (sibling file / PRISM_ADAPTER_DIR / uv).
use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=PRISM_ADAPTER_EXE");
    println!("cargo:rustc-check-cfg=cfg(embed_adapter)");
    if let Ok(path) = env::var("PRISM_ADAPTER_EXE") {
        if !path.trim().is_empty() {
            println!("cargo:rerun-if-changed={path}");
            println!("cargo:rustc-env=PRISM_EMBEDDED_ADAPTER={path}");
            println!("cargo:rustc-cfg=embed_adapter");
        }
    }

    // Embed a Common-Controls v6 manifest so ListView group view and modern visual styles
    // are active. Without it, comctl32 stays on the classic v5 look and LVM_ENABLEGROUPVIEW
    // is a no-op. embed-manifest handles both the MSVC and GNU toolchains with no external
    // resource compiler.
    if env::var_os("CARGO_CFG_WINDOWS").is_some() {
        use embed_manifest::{embed_manifest, new_manifest};
        embed_manifest(new_manifest("Prism.Gui")).expect("unable to embed manifest");

        // App icon (prism.rc: icon resource 1). Explorer and the taskbar read it from
        // the exe, the window classes load it via LoadIconW. manifest_optional() keeps
        // cross-checks from a host without a resource compiler working (the exe then
        // just lacks the icon).
        println!("cargo:rerun-if-changed=prism.rc");
        println!("cargo:rerun-if-changed=prism.ico");
        embed_resource::compile("prism.rc", embed_resource::NONE)
            .manifest_optional()
            .expect("unable to embed icon resource");
    }
}
