#!/bin/bash
# Regenerate Prism.icns, the pre-Tahoe fallback icon: the Icon Composer layer
# composited onto the classic dark squircle (squircle-bg.svg).
# Requires rsvg-convert (brew install librsvg) and ImageMagick (magick).
# The layer file name and placement mirror Prism.icon/icon.json, keep them in
# sync when the icon document changes.
set -euo pipefail
cd "$(dirname "$0")"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# The layer asset is an SVG shell around a base64 PNG (Icon Composer bitmap import)
perl -0777 -ne 'print $1 if /base64,([A-Za-z0-9+\/=\s]+?)"/s' \
  Prism.icon/Assets/Unknown-5.svg | base64 -D > "$WORK/layer.png"

rsvg-convert -w 1024 -h 1024 squircle-bg.svg -o "$WORK/bg.png"

# icon.json: scale 1 maps the 1024pt layer onto the 824px squircle box at
# (100,100), and translation (4.5625, -4.65625) becomes about (+4, -4)
magick "$WORK/bg.png" \( "$WORK/layer.png" -resize 824x824 \) \
  -geometry +104+96 -composite "$WORK/flat-1024.png"

ICONSET="$WORK/Prism.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  for scale in 1 2; do
    px=$((s * scale))
    name="icon_${s}x${s}.png"
    [ "$scale" = 2 ] && name="icon_${s}x${s}@2x.png"
    if [ "$px" -le 48 ]; then
      magick "$WORK/flat-1024.png" -filter Lanczos -resize ${px}x${px} \
        -unsharp 0x0.75+0.75+0.008 "$ICONSET/$name"
    else
      magick "$WORK/flat-1024.png" -filter Lanczos -resize ${px}x${px} "$ICONSET/$name"
    fi
  done
done

iconutil -c icns "$ICONSET" -o Prism.icns
echo "Wrote $(pwd)/Prism.icns"
