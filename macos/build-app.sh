#!/bin/bash
# Build the Rust core + SwiftUI front-end and assemble a launchable Curator.app.
#
#   bash macos/build-app.sh [debug|release]   (default: release)
#
# The app finds the adapter via CURATOR_ADAPTER_BIN (a frozen adapter binary) or
# CURATOR_ADAPTER_DIR (a uv project); set one before launching for dev. A shipped
# build would embed the frozen adapter inside Curator.app/Contents/Resources.
set -euo pipefail

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
# uniffi's generated banner uses warning-sign glyphs; keep the tree emoji-free
perl -i -pe 's/\xE2\x9A\xA0\xEF\xB8\x8F ?//g; s/ +$//' \
    "$HERE/Sources/curator_ffiFFI/include/curator_ffiFFI.h"
rm -rf "$HERE/.bindings"

echo ">> swiftpm build ($CFG)"
( cd "$HERE" && CURATOR_RUST_LIB_DIR="$LIBDIR" swift build $SWIFT_FLAGS --product CuratorApp )
BIN=$(cd "$HERE" && CURATOR_RUST_LIB_DIR="$LIBDIR" swift build $SWIFT_FLAGS --product CuratorApp --show-bin-path)/CuratorApp

echo ">> assemble $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Curator"

# Embed the Rust dylib and repoint the executable at it, so the .app is relocatable
# (the linker picks libcurator_ffi.dylib over the .a; without this it would load from
# the build machine's $LIBDIR). No-op when the binary linked the static lib instead.
DYLIB_NAME=libcurator_ffi.dylib
OLD_DYLIB=$(otool -L "$APP/Contents/MacOS/Curator" | awk '/libcurator_ffi\.dylib/{print $1; exit}')
if [ -n "${OLD_DYLIB:-}" ]; then
  cp "$LIBDIR/$DYLIB_NAME" "$APP/Contents/MacOS/$DYLIB_NAME"
  install_name_tool -id "@executable_path/$DYLIB_NAME" "$APP/Contents/MacOS/$DYLIB_NAME"
  install_name_tool -change "$OLD_DYLIB" "@executable_path/$DYLIB_NAME" "$APP/Contents/MacOS/Curator"
  echo "   embedded $DYLIB_NAME (was $OLD_DYLIB)"
fi

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

echo ">> build + embed the adapter (PyInstaller one-file)"
# The app resolves Contents/Resources/adapter/curator-adapter automatically (AppModel).
# Set CURATOR_SKIP_ADAPTER=1 to skip the ~2-min freeze during Swift-only iteration
# (the app then falls back to CURATOR_ADAPTER_DIR/_BIN).
ADAPTER_SRC="$ROOT/ps2exe-adapter"
if [ "${CURATOR_SKIP_ADAPTER:-0}" = "1" ]; then
  echo "   skipped (CURATOR_SKIP_ADAPTER=1); app uses CURATOR_ADAPTER_DIR/_BIN"
else
  ( cd "$ADAPTER_SRC" && uv run --group dev pyinstaller --noconfirm \
      --workpath build --distpath dist curator-adapter.spec )
  mkdir -p "$APP/Contents/Resources/adapter"
  cp "$ADAPTER_SRC/dist/curator-adapter" "$APP/Contents/Resources/adapter/curator-adapter"
  chmod +x "$APP/Contents/Resources/adapter/curator-adapter"
  echo "   embedded adapter ($(du -h "$APP/Contents/Resources/adapter/curator-adapter" | cut -f1)) — app is self-contained"
fi

echo ">> done: $APP"
if [ -d "$APP/Contents/Resources/adapter" ]; then
  echo "   launch:  open \"$APP\"   (adapter embedded)"
else
  echo "   launch (dev):  CURATOR_ADAPTER_DIR=\"$ROOT/ps2exe-adapter\" open \"$APP\""
fi
