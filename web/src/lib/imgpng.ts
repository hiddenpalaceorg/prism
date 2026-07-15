// BMP/TGA → PNG conversion. Link unfurlers (Discord, Slack, Twitter) and
// satori (the OG card renderer) only handle web image formats, but dumps carry
// raw BMP and TGA screenshots — convert those on the fly; formats we can't
// convert (ico, svg) fall back to the build's generated card. Browsers render
// BMP natively but not TGA, so the viewer and gallery also route TGA through
// /api/asset/<sha>/png.

import bmp from "bmp-js";
import { PNG } from "pngjs";

/** Formats unfurlers render directly as og:image. */
export const WEB_SAFE_IMAGE = /^image\/(png|jpe?g|gif|webp)$/;

/** Mimes /api/asset/<sha>/png can convert. */
export function pngConvertible(mime: string): boolean {
  return mime === "image/bmp" || mime === "image/x-tga";
}

/** Convert a pngConvertible asset to PNG. Throws on malformed input. */
export function toPng(mime: string, bytes: Buffer): Buffer {
  return mime === "image/x-tga" ? tgaToPng(bytes) : bmpToPng(bytes);
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

// TGA decode, hand-rolled: the format is trivial and the npm decoders are as
// unmaintained as bmp-js. Covers what game dumps carry — 8bpp grayscale and
// color-mapped, 15/16bpp, 24/32bpp, raw and RLE, either vertical origin.
// Mirrors curator-core/src/tga.rs (the Windows GUI's TGA→BMP staging).

/** Expand a 5-bit channel to 8 bits by bit replication. */
function scale5(c: number): number {
  return (c << 3) | (c >> 2);
}

/** One pixel or palette entry in the file's layout → [r,g,b,a]. Formats
 *  without an alpha channel yield 0 — tgaToPng flips an all-zero alpha plane
 *  to opaque. */
function unpackTga(bytes: Buffer, o: number, bits: number): [number, number, number, number] {
  if (bits === 15 || bits === 16) {
    const v = bytes.readUInt16LE(o);
    return [scale5((v >> 10) & 31), scale5((v >> 5) & 31), scale5(v & 31), 0];
  }
  if (bits === 24) return [bytes[o + 2], bytes[o + 1], bytes[o], 0];
  return [bytes[o + 2], bytes[o + 1], bytes[o], bytes[o + 3]]; // 32
}

/** Decode a TGA and re-encode as PNG. Throws on malformed input. */
export function tgaToPng(bytes: Buffer): Buffer {
  if (bytes.length < 18) throw new Error("not a TGA");
  const idLen = bytes[0];
  const cmapType = bytes[1];
  const imageType = bytes[2];
  const cmapFirst = bytes.readUInt16LE(3);
  const cmapLen = bytes.readUInt16LE(5);
  const cmapBits = bytes[7];
  const width = bytes.readUInt16LE(12);
  const height = bytes.readUInt16LE(14);
  const depth = bytes[16];
  const desc = bytes[17];

  if (cmapType > 1 || ![1, 2, 3, 9, 10, 11].includes(imageType)) throw new Error("not a TGA");
  if (![8, 15, 16, 24, 32].includes(depth)) throw new Error(`unsupported TGA depth ${depth}`);
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) {
    throw new Error(`TGA dimensions out of range: ${width}x${height}`);
  }
  const colorMapped = imageType === 1 || imageType === 9;
  const gray = imageType === 3 || imageType === 11;
  if (colorMapped && (cmapType !== 1 || depth !== 8)) {
    throw new Error("unsupported color-mapped TGA layout");
  }

  let off = 18 + idLen;

  // The palette rides along even when a truecolor image merely carries one;
  // decode entries only when pixels actually index into it.
  const palette: Array<[number, number, number, number]> = [];
  if (cmapType === 1) {
    if (![15, 16, 24, 32].includes(cmapBits)) {
      throw new Error(`unsupported TGA palette depth ${cmapBits}`);
    }
    const entryBytes = (cmapBits + 7) >> 3;
    const end = off + cmapLen * entryBytes;
    if (end > bytes.length) throw new Error("truncated TGA");
    if (colorMapped) {
      for (let i = 0; i < cmapLen; i++) palette.push(unpackTga(bytes, off + i * entryBytes, cmapBits));
    }
    off = end;
  }

  const bpp = (depth + 7) >> 3;
  const count = width * height;
  const px = Buffer.alloc(count * 4); // RGBA in file scan order

  const readPixel = (o: number): [number, number, number, number] => {
    if (o + bpp > bytes.length) throw new Error("truncated TGA");
    if (colorMapped) {
      const entry = palette[bytes[o] - cmapFirst];
      if (!entry) throw new Error("TGA palette index out of range");
      return entry;
    }
    if (gray) return [bytes[o], bytes[o], bytes[o], 0];
    return unpackTga(bytes, o, depth);
  };

  const put = (i: number, [r, g, b, a]: [number, number, number, number]) => {
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
    px[i * 4 + 3] = a;
  };

  if (imageType >= 9) {
    // RLE: header byte per packet — bit 7 = run, low 7 bits = count-1.
    let i = 0;
    while (i < count) {
      if (off >= bytes.length) throw new Error("truncated TGA");
      const hdr = bytes[off++];
      const n = (hdr & 0x7f) + 1;
      if (i + n > count) throw new Error("corrupt TGA RLE stream");
      if (hdr & 0x80) {
        const p = readPixel(off);
        off += bpp;
        for (let j = i; j < i + n; j++) put(j, p);
      } else {
        for (let j = i; j < i + n; j++) {
          put(j, readPixel(off));
          off += bpp;
        }
      }
      i += n;
    }
  } else {
    for (let j = 0; j < count; j++) {
      put(j, readPixel(off));
      off += bpp;
    }
  }

  // Alpha-less formats decode with alpha 0 everywhere; that means opaque, not
  // an invisible image (same convention as bmpToPng).
  let maxAlpha = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > maxAlpha) maxAlpha = px[i];
  if (maxAlpha === 0) for (let i = 3; i < px.length; i += 4) px[i] = 255;

  // Reorder scan lines to top-down; descriptor bit 5 = top origin,
  // bit 4 = right-to-left.
  const topOrigin = (desc & 0x20) !== 0;
  const rightToLeft = (desc & 0x10) !== 0;
  const png = new PNG({ width, height });
  for (let row = 0; row < height; row++) {
    const y = topOrigin ? row : height - 1 - row;
    for (let col = 0; col < width; col++) {
      const x = rightToLeft ? width - 1 - col : col;
      px.copy(png.data, (y * width + x) * 4, (row * width + col) * 4, (row * width + col) * 4 + 4);
    }
  }
  return PNG.sync.write(png);
}
