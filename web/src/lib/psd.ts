// PSD → PNG conversion for gallery thumbnails, OG images, and the viewer's
// no-layer-support fallback. The interactive layer viewer parses the raw PSD
// client-side (PsdViewer.tsx); this module only needs a faithful flattened
// frame. Photoshop stores one ready-made when "Maximize Compatibility" was on
// at save time — most real files — so the common path is a straight decode of
// the composite. Files saved without it get a naive re-flatten from the layer
// stack (normal blend only): approximate, but a thumbnail beats a hex dump.

import { initializeCanvas, readPsd, type Layer, type Psd } from "ag-psd";
import { PNG } from "pngjs";

// Node has no ImageData (or canvas) global; ag-psd asks for one when decoding
// bitmaps even in useImageData mode. A bare width/height/data triple is all
// the reader actually touches. The createCanvas slot throws instead of
// degrading silently — nothing on the useImageData path should ever call it.
initializeCanvas(
  () => {
    throw new Error("canvas is not available server-side (useImageData paths only)");
  },
  (width, height) =>
    ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData
);

/** Mimes /api/asset/<sha>/png can convert through this module. */
export function psdConvertible(mime: string): boolean {
  return mime === "image/vnd.adobe.photoshop";
}

// Same posture as imgpng.ts: dimensions are attacker-controlled bytes and the
// flatten allocates width*height*4 up front.
const MAX_PIXELS = 32_000_000;

/** Convert a PSD/PSB to a flattened PNG. Throws on malformed input. */
export function psdToPng(bytes: Buffer): Buffer {
  // useImageData keeps ag-psd off the DOM canvas API (absent in Node); the
  // composite arrives as raw RGBA instead.
  const psd = readPsd(bytes, {
    skipLayerImageData: true,
    skipThumbnail: true,
    useImageData: true,
  });
  if (psd.width * psd.height > MAX_PIXELS) {
    throw new Error(`PSD too large: ${psd.width}x${psd.height}`);
  }

  // A file saved without "Maximize Compatibility" still carries an image data
  // section, but it's a blank (uniform white) frame, not the artwork — detect
  // that and re-flatten from the layers instead. A legitimately solid-color
  // document flattens to the same solid color, so the heuristic can't hurt.
  const comp = psd.imageData?.data?.length ? rgba8(psd.imageData.data) : null;
  const blankComposite = (psd.children?.length ?? 0) > 0 && comp && isUniform(comp);
  const rgba = comp && !blankComposite ? comp : flattenLayers(bytes, psd);

  const png = new PNG({ width: psd.width, height: psd.height });
  rgba.copy(png.data);
  return PNG.sync.write(png);
}

/** Pixel data as 8-bit RGBA bytes (16/32-bit depths downconverted). */
function rgba8(data: Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array): Buffer {
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    return Buffer.from(data.buffer, data.byteOffset, data.length);
  }
  const out = Buffer.alloc(data.length);
  if (data instanceof Uint16Array) {
    for (let i = 0; i < data.length; i++) out[i] = data[i] >> 8;
  } else {
    for (let i = 0; i < data.length; i++) out[i] = Math.max(0, Math.min(255, data[i] * 255));
  }
  return out;
}

function isUniform(data: Buffer): boolean {
  for (let i = 4; i < data.length; i += 4) {
    if (
      data[i] !== data[0] ||
      data[i + 1] !== data[1] ||
      data[i + 2] !== data[2] ||
      data[i + 3] !== data[3]
    ) {
      return false;
    }
  }
  return true;
}

/** Bottom-to-top source-over flatten of the visible layers, for files saved
 *  without a real composite. Ignores blend modes, masks, and clipping — the
 *  layer viewer is where fidelity lives; this only backs thumbnails. */
function flattenLayers(bytes: Buffer, shape: Psd): Buffer {
  const psd = readPsd(bytes, { skipThumbnail: true, useImageData: true });
  const out = Buffer.alloc(shape.width * shape.height * 4);
  const walk = (layers: Layer[] | undefined) => {
    for (const layer of layers ?? []) {
      if (layer.hidden) continue;
      if (layer.children) {
        walk(layer.children);
        continue;
      }
      const img = layer.imageData;
      if (!img?.data?.length) continue;
      const src = rgba8(img.data);
      const opacity = layer.opacity ?? 1;
      const left = layer.left ?? 0;
      const top = layer.top ?? 0;
      for (let y = 0; y < img.height; y++) {
        const dy = top + y;
        if (dy < 0 || dy >= shape.height) continue;
        for (let x = 0; x < img.width; x++) {
          const dx = left + x;
          if (dx < 0 || dx >= shape.width) continue;
          const s = (y * img.width + x) * 4;
          const a = (src[s + 3] / 255) * opacity;
          if (a === 0) continue;
          const d = (dy * shape.width + dx) * 4;
          for (let c = 0; c < 3; c++) {
            out[d + c] = Math.round(src[s + c] * a + out[d + c] * (1 - a));
          }
          out[d + 3] = Math.round(255 * (a + (out[d + 3] / 255) * (1 - a)));
        }
      }
    }
  };
  walk(psd.children);
  return out;
}
