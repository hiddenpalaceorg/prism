// swift-tools-version:5.9
import PackageDescription

// Build the Rust core first so the static lib exists:
//   cargo build -p curator-ffi              (debug)   -> ../target/debug/libcurator_ffi.a
//   cargo build -p curator-ffi --release    (release) -> ../target/release/libcurator_ffi.a
// Then:  swift build            (uses debug; pass -c release + -Xlinker for release)
//
// CURATOR_RUST_LIB_DIR overrides the search dir if you build elsewhere.
import Foundation
let rustLibDir = ProcessInfo.processInfo.environment["CURATOR_RUST_LIB_DIR"] ?? "../target/debug"

let linkRust: [LinkerSetting] = [
    .unsafeFlags(["-L\(rustLibDir)", "-lcurator_ffi"]),
    // Frameworks/libs the Rust staticlib (rusqlite bundled sqlite, blake3, std) needs.
    .linkedLibrary("c++"),
    .linkedFramework("CoreFoundation"),
    .linkedFramework("Security"),
]

let package = Package(
    name: "Curator",
    platforms: [.macOS(.v13)],
    targets: [
        // C target exposing the UniFFI scaffolding header to Swift.
        .target(
            name: "curator_ffiFFI",
            path: "Sources/curator_ffiFFI"
        ),
        // Generated Swift bindings + hand-written Swift conveniences.
        .target(
            name: "CuratorKit",
            dependencies: ["curator_ffiFFI"],
            path: "Sources/CuratorKit"
        ),
        // The SwiftUI app.
        .executableTarget(
            name: "CuratorApp",
            dependencies: ["CuratorKit"],
            path: "Sources/CuratorApp",
            linkerSettings: linkRust
        ),
        // Headless runtime check that the FFI round-trips (no GUI session needed).
        .executableTarget(
            name: "curator-probe",
            dependencies: ["CuratorKit"],
            path: "Sources/curator-probe",
            linkerSettings: linkRust
        ),
    ]
)
