#!/bin/sh
# Build the Rust core + SwiftUI front-end and assemble a launchable Curator.app.
#
#   sh macos/build-app.sh [debug|release]   (default: release)
#
# The app finds the adapter via CURATOR_ADAPTER_BIN (a Phase-2 bundle) or
# CURATOR_ADAPTER_DIR (a uv project); set one before launching for dev. A shipped
# build would embed the Phase-2 bundle inside Curator.app/Contents/Resources.
set -e

CFG=${1:-release}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
APP="$HERE/dist/Curator.app"

case "$CFG" in
  release) CARGO_FLAGS=--release; SWIFT_FLAGS="-c release"; LIBDIR="$ROOT/target/release" ;;
  debug)   CARGO_FLAGS=;          SWIFT_FLAGS=;             LIBDIR="$ROOT/target/debug" ;;
  *) echo "usage: $0 [debug|release]" >&2; exit 1 ;;
esac

echo ">> rust static lib ($CFG)"
( cd "$ROOT" && cargo build -p curator-ffi $CARGO_FLAGS )

echo ">> regenerate Swift bindings from the built dylib"
DYLIB="$LIBDIR/libcurator_ffi.dylib"
( cd "$ROOT" && cargo run -p curator-ffi --bin uniffi-bindgen $CARGO_FLAGS -- \
    generate --library "$DYLIB" --language swift --out-dir "$HERE/.bindings" )
cp "$HERE/.bindings/curator_ffi.swift"        "$HERE/Sources/CuratorKit/curator_ffi.swift"
cp "$HERE/.bindings/curator_ffiFFI.h"         "$HERE/Sources/curator_ffiFFI/include/curator_ffiFFI.h"
cp "$HERE/.bindings/curator_ffiFFI.modulemap" "$HERE/Sources/curator_ffiFFI/include/module.modulemap"
rm -rf "$HERE/.bindings"

echo ">> swiftpm build ($CFG)"
( cd "$HERE" && CURATOR_RUST_LIB_DIR="$LIBDIR" swift build $SWIFT_FLAGS --product CuratorApp )
BIN=$(cd "$HERE" && CURATOR_RUST_LIB_DIR="$LIBDIR" swift build $SWIFT_FLAGS --product CuratorApp --show-bin-path)/CuratorApp

echo ">> assemble $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Curator"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>            <string>Curator</string>
  <key>CFBundleDisplayName</key>     <string>Curator</string>
  <key>CFBundleIdentifier</key>      <string>org.hiddenpalace.curator</string>
  <key>CFBundleVersion</key>         <string>0.1.0</string>
  <key>CFBundleShortVersionString</key> <string>0.1.0</string>
  <key>CFBundleExecutable</key>      <string>Curator</string>
  <key>CFBundlePackageType</key>     <string>APPL</string>
  <key>LSMinimumSystemVersion</key>  <string>13.0</string>
  <key>NSHighResolutionCapable</key> <true/>
</dict>
</plist>
PLIST

echo ">> embed adapter bundle (if built)"
# The app resolves Contents/Resources/adapter/curator-adapter automatically. Build it
# first with `python ps2exe-adapter/bundle.py`; relocatable, so copying it here works.
BUNDLE="$ROOT/ps2exe-adapter/dist/bundle"
if [ -d "$BUNDLE" ] && [ -x "$BUNDLE/curator-adapter" ]; then
  cp -R "$BUNDLE" "$APP/Contents/Resources/adapter"
  echo "   embedded $(du -sh "$APP/Contents/Resources/adapter" | cut -f1) adapter — app is self-contained"
else
  echo "   no bundle at $BUNDLE — app falls back to CURATOR_ADAPTER_DIR/_BIN."
  echo "   build one with:  python ps2exe-adapter/bundle.py   then re-run this script."
fi

echo ">> done: $APP"
if [ -d "$APP/Contents/Resources/adapter" ]; then
  echo "   launch:  open \"$APP\"   (adapter embedded)"
else
  echo "   launch (dev):  CURATOR_ADAPTER_DIR=\"$ROOT/ps2exe-adapter\" open \"$APP\""
fi
