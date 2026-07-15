// BMP → PNG conversion for social previews. Link unfurlers (Discord, Slack,
// Twitter) and satori (the OG card renderer) only handle web image formats,
// but dumps carry raw BMP screenshots — convert those on the fly; formats we
// can't convert (ico, svg) fall back to the build's generated card.

import bmp from "bmp-js";
import { PNG } from "pngjs";

/** Formats unfurlers render directly as og:image. */
export const WEB_SAFE_IMAGE = /^image\/(png|jpe?g|gif|webp)$/;

/** Mimes /api/asset/<sha>/png can convert. */
export function pngConvertible(mime: string): boolean {
  return mime === "image/bmp";
}

// Refuse to decode absurd dimensions (decode allocates width*height*4 up
// front, and headers are attacker-controlled bytes).
const MAX_PIXELS = 16_000_000;

// The standard BGRA channel masks — what every mainstream tool writes when it
// uses BI_BITFIELDS on 24/32bpp instead of plain BI_RGB.
const STD_MASKS = { r: 0xff0000, g: 0xff00, b: 0xff };

/**
 * Rewrite a BMP into the one layout bmp-js actually parses: 40-byte
 * BITMAPINFOHEADER, palette, pixels — with nothing in between. bmp-js never
 * seeks to the header's declared pixel-data offset, so V4/V5 headers (124
 * bytes from e.g. sips/Photoshop) decode shifted by the extra header bytes.
 * Its BI_BITFIELDS path is also broken (reads masks, then ignores them), so
 * standard-mask bitfields are converted to plain BI_RGB and anything with
 * exotic masks is rejected.
 */
function normalizeBmp(bytes: Buffer): Buffer {
  if (bytes.length < 54 || bytes.toString("latin1", 0, 2) !== "BM") {
    throw new Error("not a BMP");
  }
  const dataOffset = bytes.readUInt32LE(10);
  const dibSize = bytes.readUInt32LE(14);
  const bpp = bytes.readUInt16LE(28);
  const originalCompress = bytes.readUInt32LE(30);
  let compress = originalCompress;

  if (compress === 3) {
    // Masks sit at absolute 54 in both layouts (after a 40-byte header, or as
    // the V4/V5 header fields at DIB offset 40).
    const [r, g, b] = [54, 58, 62].map((o) => bytes.readUInt32LE(o));
    if (r !== STD_MASKS.r || g !== STD_MASKS.g || b !== STD_MASKS.b) {
      throw new Error("unsupported BMP channel masks");
    }
    compress = 0;
  }

  const colors = bytes.readUInt32LE(46);
  const paletteLen = bpp < 15 ? (colors === 0 ? 1 << bpp : colors) * 4 : 0;
  const canonicalOffset = 14 + 40 + paletteLen;
  if (dibSize === 40 && compress === originalCompress && dataOffset === canonicalOffset) {
    return bytes; // already the layout bmp-js expects
  }

  const fileHeader = Buffer.from(bytes.subarray(0, 14));
  fileHeader.writeUInt32LE(canonicalOffset, 10);
  const dib = Buffer.from(bytes.subarray(14, 54));
  dib.writeUInt32LE(40, 0);
  dib.writeUInt32LE(compress, 16);
  const palette = bytes.subarray(14 + dibSize, 14 + dibSize + paletteLen);
  return Buffer.concat([fileHeader, dib, palette, bytes.subarray(dataOffset)]);
}

/** Decode a BMP and re-encode as PNG. Throws on malformed input. */
export function bmpToPng(bytes: Buffer): Buffer {
  const normalized = normalizeBmp(bytes);
  const w = normalized.readInt32LE(18);
  const h = Math.abs(normalized.readInt32LE(22));
  if (w <= 0 || h === 0 || w * h > MAX_PIXELS) {
    throw new Error(`BMP dimensions out of range: ${w}x${h}`);
  }
  const { width, height, data } = bmp.decode(normalized); // ABGR per pixel
  const png = new PNG({ width, height });
  let maxAlpha = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i];
    if (a > maxAlpha) maxAlpha = a;
    png.data[i] = data[i + 3];
    png.data[i + 1] = data[i + 2];
    png.data[i + 2] = data[i + 1];
    png.data[i + 3] = a;
  }
  // Alpha-less BMPs (24bpp and lower) decode with alpha 0 everywhere; that
  // means opaque, not an invisible image.
  if (maxAlpha === 0) {
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  }
  return PNG.sync.write(png);
}
