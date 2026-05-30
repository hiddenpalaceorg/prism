#!/bin/sh
# Build a self-contained adapter bundle: a relocatable standalone Python with the
# locked deps installed, plus the adapter + ps2exe source and a launcher. The desktop
# app invokes <bundle>/curator-adapter with no uv/Python/dev-tools on the target.
#
# Not handled here: macOS code-signing/notarization (needs certs), and `unrar`
# (rarfile) for .rar inputs. See README.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
OUT="$HERE/dist/bundle"

echo ">> standalone CPython 3.10 (uv-managed, relocatable)"
uv python install --managed-python 3.10
PYBIN=$(uv python find --managed-python ">=3.10,<3.11")
PYDIR=$(cd "$(dirname "$PYBIN")/.." && pwd)
echo "   $PYDIR"

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$PYDIR" "$OUT/python"
BPY="$OUT/python/bin/python3.10"
# this copy is ours to modify; drop uv's "externally managed" marker so pip can install
find "$OUT/python" -name 'EXTERNALLY-MANAGED' -delete

echo ">> bootstrap pip into the bundle interpreter (uv-managed CPython ships locked down)"
export PIP_BREAK_SYSTEM_PACKAGES=1
curl -fsSL https://bootstrap.pypa.io/get-pip.py -o "$OUT/get-pip.py"
"$BPY" "$OUT/get-pip.py" --no-warn-script-location
rm -f "$OUT/get-pip.py"

echo ">> locked deps -> bundle interpreter"
( cd "$HERE" && uv export --format requirements-txt --no-hashes --no-dev --no-emit-project > "$OUT/requirements.txt" )
"$BPY" -m pip install --no-warn-script-location --disable-pip-version-check \
    -r "$OUT/requirements.txt"

echo ">> prune GUI/dev deps the adapter never imports (pyisotools pulls PySide6 etc.)"
# Only the clearly GUI/dev-only packages (pyisotools also pulls a runtime stack —
# chardet/requests/etc. — that we must keep). PySide6 alone is the ~1.1 GB win.
PRUNE="pyside6 pyside6-addons pyside6-essentials shiboken6 qdarkstyle qtpy \
  pyinstaller pyinstaller-hooks-contrib altgraph macholib \
  pylint astroid dill isort mccabe"
for p in $PRUNE; do
  "$BPY" -m pip uninstall -y --break-system-packages "$p" >/dev/null 2>&1 || true
done

echo ">> bundle an archive tool (ps2exe requires a 7z/unrar tool at import)"
# NOTE: unrar carries the unRAR license (extraction-only redistribution OK). Prefer a
# native 7zz if present; else a standalone unrar (x86_64 runs via Rosetta on arm64).
mkdir -p "$OUT/bin"
SEVENZIP=$(command -v 7zz 2>/dev/null || true)
UNRAR=$(command -v unrar 2>/dev/null || echo /usr/local/bin/unrar)
if [ -n "$SEVENZIP" ] && [ -x "$SEVENZIP" ]; then
  cp "$SEVENZIP" "$OUT/bin/7zz"; echo "   bundled 7zz"
elif [ -x "$UNRAR" ] && file "$UNRAR" | grep -q Mach-O; then
  cp "$UNRAR" "$OUT/bin/unrar"; echo "   bundled unrar"
else
  echo "   WARNING: no standalone 7zz/unrar found; provide one in $OUT/bin for .rar/.7z"
fi

echo ">> app + engine source"
cp -R "$HERE/curator_adapter" "$OUT/curator_adapter"
mkdir -p "$OUT/ps2exe"
cp -R "$ROOT/lib/ps2exe/." "$OUT/ps2exe/"
# drop caches/VCS noise
find "$OUT" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true

echo ">> launcher"
cat > "$OUT/curator-adapter" <<'EOF'
#!/bin/sh
DIR=$(cd "$(dirname "$0")" && pwd)
export CURATOR_PS2EXE_DIR="$DIR/ps2exe"
export PYTHONPATH="$DIR"
# bundled 7zz first, then system dirs (for bsdtar / libarchive); no dev PATH needed
export PATH="$DIR/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "$DIR/python/bin/python3.10" -m curator_adapter.cli "$@"
EOF
chmod +x "$OUT/curator-adapter"

echo ">> done: $OUT  ($(du -sh "$OUT" | cut -f1))"
