#!/bin/bash
# Build the Rust core + SwiftUI front-end and assemble a launchable Prism.app.
#
#   bash macos/build-app.sh [debug|release]   (default: release)
#
# The app finds the adapter via PRISM_ADAPTER_BIN (a frozen adapter binary) or
# PRISM_ADAPTER_DIR (a uv project); set one before launching for dev. A shipped
# build would embed the frozen adapter inside Prism.app/Contents/Resources.
set -euo pipefail

CFG=${1:-release}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
APP="$HERE/dist/Prism.app"

case "$CFG" in
  release) CARGO_FLAGS=--release; SWIFT_FLAGS="-c release"; LIBDIR="$ROOT/target/release" ;;
  debug)   CARGO_FLAGS=;          SWIFT_FLAGS=;             LIBDIR="$ROOT/target/debug" ;;
  *) echo "usage: $0 [debug|release]" >&2; exit 1 ;;
esac

echo ">> rust static lib ($CFG)"
( cd "$ROOT" && cargo build -p prism-ffi $CARGO_FLAGS )

echo ">> regenerate Swift bindings from the built dylib"
DYLIB="$LIBDIR/libprism_ffi.dylib"
( cd "$ROOT" && cargo run -p prism-ffi --bin uniffi-bindgen $CARGO_FLAGS -- \
    generate --library "$DYLIB" --language swift --out-dir "$HERE/.bindings" )
cp "$HERE/.bindings/prism_ffi.swift"        "$HERE/Sources/PrismKit/prism_ffi.swift"
cp "$HERE/.bindings/prism_ffiFFI.h"         "$HERE/Sources/prism_ffiFFI/include/prism_ffiFFI.h"
cp "$HERE/.bindings/prism_ffiFFI.modulemap" "$HERE/Sources/prism_ffiFFI/include/module.modulemap"
# uniffi's generated banner uses warning-sign glyphs; keep the tree emoji-free
perl -i -pe 's/\xE2\x9A\xA0\xEF\xB8\x8F ?//g; s/ +$//' \
    "$HERE/Sources/prism_ffiFFI/include/prism_ffiFFI.h"
rm -rf "$HERE/.bindings"

echo ">> swiftpm build ($CFG)"
( cd "$HERE" && PRISM_RUST_LIB_DIR="$LIBDIR" swift build $SWIFT_FLAGS --product PrismApp )
BIN=$(cd "$HERE" && PRISM_RUST_LIB_DIR="$LIBDIR" swift build $SWIFT_FLAGS --product PrismApp --show-bin-path)/PrismApp

echo ">> assemble $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Prism"

# Embed the Rust dylib and repoint the executable at it, so the .app is relocatable
# (the linker picks libprism_ffi.dylib over the .a; without this it would load from
# the build machine's $LIBDIR). No-op when the binary linked the static lib instead.
DYLIB_NAME=libprism_ffi.dylib
OLD_DYLIB=$(otool -L "$APP/Contents/MacOS/Prism" | awk '/libprism_ffi\.dylib/{print $1; exit}')
if [ -n "${OLD_DYLIB:-}" ]; then
  cp "$LIBDIR/$DYLIB_NAME" "$APP/Contents/MacOS/$DYLIB_NAME"
  install_name_tool -id "@executable_path/$DYLIB_NAME" "$APP/Contents/MacOS/$DYLIB_NAME"
  install_name_tool -change "$OLD_DYLIB" "@executable_path/$DYLIB_NAME" "$APP/Contents/MacOS/Prism"
  echo "   embedded $DYLIB_NAME (was $OLD_DYLIB)"
fi

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>            <string>Prism</string>
  <key>CFBundleDisplayName</key>     <string>Prism</string>
  <key>CFBundleIdentifier</key>      <string>org.hiddenpalace.prism</string>
  <key>CFBundleVersion</key>         <string>0.1.0</string>
  <key>CFBundleShortVersionString</key> <string>0.1.0</string>
  <key>CFBundleExecutable</key>      <string>Prism</string>
  <key>CFBundlePackageType</key>     <string>APPL</string>
  <key>LSMinimumSystemVersion</key>  <string>13.0</string>
  <key>NSHighResolutionCapable</key> <true/>
</dict>
</plist>
PLIST

echo ">> build + embed the adapter (PyInstaller one-file)"
# The app resolves Contents/Resources/adapter/prism-adapter automatically (AppModel).
# Set PRISM_SKIP_ADAPTER=1 to skip the ~2-min freeze during Swift-only iteration
# (the app then falls back to PRISM_ADAPTER_DIR/_BIN).
ADAPTER_SRC="$ROOT/ps2exe-adapter"
if [ "${PRISM_SKIP_ADAPTER:-0}" = "1" ]; then
  echo "   skipped (PRISM_SKIP_ADAPTER=1); app uses PRISM_ADAPTER_DIR/_BIN"
else
  ( cd "$ADAPTER_SRC" && uv run --group dev pyinstaller --noconfirm \
      --workpath build --distpath dist prism-adapter.spec )
  mkdir -p "$APP/Contents/Resources/adapter"
  cp "$ADAPTER_SRC/dist/prism-adapter" "$APP/Contents/Resources/adapter/prism-adapter"
  chmod +x "$APP/Contents/Resources/adapter/prism-adapter"
  echo "   embedded adapter ($(du -h "$APP/Contents/Resources/adapter/prism-adapter" | cut -f1)) — app is self-contained"
fi

echo ">> done: $APP"
if [ -d "$APP/Contents/Resources/adapter" ]; then
  echo "   launch:  open \"$APP\"   (adapter embedded)"
else
  echo "   launch (dev):  PRISM_ADAPTER_DIR=\"$ROOT/ps2exe-adapter\" open \"$APP\""
fi
