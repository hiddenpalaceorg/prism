// swift-tools-version:5.9
import PackageDescription

// Build the Rust core first so the static lib exists:
//   cargo build -p prism-ffi              (debug)   -> ../target/debug/libprism_ffi.a
//   cargo build -p prism-ffi --release    (release) -> ../target/release/libprism_ffi.a
// Then:  swift build            (uses debug; pass -c release + -Xlinker for release)
//
// PRISM_RUST_LIB_DIR overrides the search dir if you build elsewhere.
import Foundation
let rustLibDir = ProcessInfo.processInfo.environment["PRISM_RUST_LIB_DIR"] ?? "../target/debug"

let linkRust: [LinkerSetting] = [
    .unsafeFlags(["-L\(rustLibDir)", "-lprism_ffi"]),
    // Frameworks/libs the Rust staticlib (rusqlite bundled sqlite, blake3, std) needs.
    .linkedLibrary("c++"),
    .linkedFramework("CoreFoundation"),
    .linkedFramework("Security"),
]

let package = Package(
    name: "Prism",
    platforms: [.macOS(.v13)],
    targets: [
        // C target exposing the UniFFI scaffolding header to Swift.
        .target(
            name: "prism_ffiFFI",
            path: "Sources/prism_ffiFFI"
        ),
        // Generated Swift bindings + hand-written Swift conveniences.
        .target(
            name: "PrismKit",
            dependencies: ["prism_ffiFFI"],
            path: "Sources/PrismKit"
        ),
        // The SwiftUI app.
        .executableTarget(
            name: "PrismApp",
            dependencies: ["PrismKit"],
            path: "Sources/PrismApp",
            linkerSettings: linkRust
        ),
        // Headless runtime check that the FFI round-trips (no GUI session needed).
        .executableTarget(
            name: "prism-probe",
            dependencies: ["PrismKit"],
            path: "Sources/prism-probe",
            linkerSettings: linkRust
        ),
    ]
)
