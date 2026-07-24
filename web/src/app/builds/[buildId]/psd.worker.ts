// Web worker behind PsdViewer: parses a PSD/PSB with ag-psd and composites
// the visible layers onto an OffscreenCanvas, so multi-megapixel decode and
// re-blend work never jank the page. Protocol:
//
//   in:  { type: "load", buf: ArrayBuffer }
//   out: { type: "loaded", width, height, layers: WorkerLayer[] }
//   in:  { type: "render", visibility: Record<id, boolean> }
//   out: { type: "frame", bitmap: ImageBitmap }   (transferred)
//   out: { type: "error", message }               (viewer falls back to /png)
//
// Layer ids are index paths into the tree ("2.0.1"). Fidelity notes: blend
// modes map onto canvas composite operations (exact for the common set,
// nearest-neighbour for exotics like vivid light), layer masks and clipping
// masks are honored, adjustment/fill layers without pixels are skipped and
// reported disabled.

import { initializeCanvas, readPsd, type Layer, type LayerMaskData, type Psd } from "ag-psd";
import { isCmykPsd, parseCmykPsd } from "../../../lib/psd-cmyk";

// Workers have no document, so ag-psd needs its canvas/ImageData factories
// pointed at the worker-native equivalents (same dance as lib/psd.ts on the
// server, which has neither).
initializeCanvas(
  ((width: number, height: number) =>
    new OffscreenCanvas(width, height)) as unknown as (w: number, h: number) => HTMLCanvasElement,
  (width, height) => new ImageData(width, height)
);

export interface WorkerLayer {
  id: string;
  name: string;
  visible: boolean;
  disabled?: boolean;
  children?: WorkerLayer[];
}

type PixelData = NonNullable<Layer["imageData"]>;

// Same decode posture as the server converter (psd.ts).
const MAX_PIXELS = 32_000_000;
// Composite budget — huge documents render downscaled rather than risking
// the mobile canvas allocation ceiling.
const RENDER_MAX_PIXELS = 16_000_000;

const BLEND: Record<string, GlobalCompositeOperation> = {
  normal: "source-over",
  dissolve: "source-over",
  darken: "darken",
  multiply: "multiply",
  "color burn": "color-burn",
  "linear burn": "multiply", // approximation
  "darker color": "darken", // approximation
  lighten: "lighten",
  screen: "screen",
  "color dodge": "color-dodge",
  "linear dodge": "lighter",
  "lighter color": "lighten", // approximation
  overlay: "overlay",
  "soft light": "soft-light",
  "hard light": "hard-light",
  "vivid light": "hard-light", // approximation
  "linear light": "hard-light", // approximation
  "pin light": "hard-light", // approximation
  "hard mix": "hard-light", // approximation
  difference: "difference",
  exclusion: "exclusion",
  subtract: "difference", // approximation
  divide: "source-over", // approximation
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

function blendOp(mode: string | undefined): GlobalCompositeOperation {
  return BLEND[mode ?? "normal"] ?? "source-over";
}

const post = (msg: unknown, transfer?: Transferable[]) =>
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(
    msg,
    transfer
  );

let doc: Psd | null = null;
const layerCanvasCache = new WeakMap<Layer, OffscreenCanvas | null>();

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: string; buf?: ArrayBuffer; visibility?: Record<string, boolean> };
  try {
    if (msg.type === "load" && msg.buf) load(msg.buf);
    else if (msg.type === "render") render(msg.visibility ?? {});
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

function load(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  doc = isCmykPsd(bytes)
    ? cmykAsDoc(bytes)
    : readPsd(bytes, { skipThumbnail: true, useImageData: true });
  if (doc.width * doc.height > MAX_PIXELS) {
    throw new Error(`PSD too large: ${doc.width}x${doc.height}`);
  }
  const layers = (doc.children ?? []).map((l, i) => layerMeta(l, String(i)));
  post({ type: "loaded", width: doc.width, height: doc.height, layers });
}

/** CMYK documents (which ag-psd refuses) through the shared hand-rolled
 *  parser, shaped like an ag-psd Psd so the compositor below needs no second
 *  code path. The corpus's press files are saved with every layer hidden —
 *  the initial canvas is honestly blank and the panel is how the art is
 *  revealed. A flattened CMYK file has no layer records to show; throwing
 *  hands it to the parent's server-PNG fallback. */
function cmykAsDoc(bytes: Uint8Array): Psd {
  const cmyk = parseCmykPsd(bytes);
  const children: Layer[] = cmyk.layers.map((l) => ({
    name: l.name,
    top: l.top,
    left: l.left,
    blendMode: l.blendMode as Layer["blendMode"],
    opacity: l.opacity,
    hidden: l.hidden,
    clipping: l.clipping,
    imageData:
      l.rgba && l.cols > 0 && l.rows > 0
        ? { width: l.cols, height: l.rows, data: l.rgba }
        : undefined,
  }));
  if (!children.some((l) => l.imageData)) {
    throw new Error("flattened CMYK file — use the composite fallback");
  }
  return { width: cmyk.width, height: cmyk.height, children } as Psd;
}

function layerMeta(l: Layer, id: string): WorkerLayer {
  return {
    id,
    name: l.name || "Layer",
    visible: !l.hidden,
    // Groups always toggle; a leaf without pixels (adjustment, fill, empty)
    // has nothing this renderer can draw.
    disabled: !l.children && !l.imageData?.data?.length,
    children: l.children?.map((c, i) => layerMeta(c, `${id}.${i}`)),
  };
}

function render(visibility: Record<string, boolean>) {
  if (!doc) throw new Error("no document loaded");
  const scale = Math.min(1, Math.sqrt(RENDER_MAX_PIXELS / (doc.width * doc.height)));
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(doc.width * scale)),
    Math.max(1, Math.round(doc.height * scale))
  );
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);

  if (doc.children?.length) {
    compositeInto(ctx, doc.children, "", visibility);
  } else if (doc.imageData) {
    // Flattened file (no layer records): the composite is the picture.
    ctx.drawImage(toCanvas(doc.imageData), 0, 0);
  }

  const bitmap = canvas.transferToImageBitmap();
  post({ type: "frame", bitmap }, [bitmap]);
}

/** Paint `layers` (bottom-to-top, PSD file order) onto `ctx`, which carries
 *  the document-to-render-scale transform. */
function compositeInto(
  ctx: OffscreenCanvasRenderingContext2D,
  layers: Layer[],
  idPrefix: string,
  visibility: Record<string, boolean>
) {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const id = idPrefix ? `${idPrefix}.${i}` : String(i);
    if (!(visibility[id] ?? !layer.hidden)) continue;

    if (layer.children) {
      const passThrough =
        (layer.blendMode ?? "pass through") === "pass through" && (layer.opacity ?? 1) === 1;
      if (passThrough) {
        compositeInto(ctx, layer.children, id, visibility);
      } else {
        // Isolated group: children flatten together first, then the result
        // blends into the parent as one unit.
        const tmp = new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height);
        const tctx = tmp.getContext("2d")!;
        tctx.setTransform(ctx.getTransform());
        compositeInto(tctx, layer.children, id, visibility);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = layer.opacity ?? 1;
        ctx.globalCompositeOperation =
          layer.blendMode === "pass through" ? "source-over" : blendOp(layer.blendMode);
        ctx.drawImage(tmp, 0, 0);
        ctx.restore();
      }
      continue;
    }

    const content = layerCanvas(layer);
    if (!content) continue;

    // Clipping masks: the run of clipping layers directly above confines its
    // pixels to this layer's alpha. Flatten base + clipped run in document
    // space, re-mask by the base's alpha, then blend the unit into the parent.
    const clipped: { layer: Layer; id: string }[] = [];
    while (i + 1 < layers.length && layers[i + 1].clipping && !layers[i + 1].children) {
      i++;
      clipped.push({ layer: layers[i], id: idPrefix ? `${idPrefix}.${i}` : String(i) });
    }

    if (clipped.length === 0) {
      drawLayer(ctx, layer, content);
      continue;
    }

    const unit = new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height);
    const uctx = unit.getContext("2d")!;
    uctx.setTransform(ctx.getTransform());
    uctx.globalAlpha = 1;
    uctx.drawImage(content, layer.left ?? 0, layer.top ?? 0);
    for (const c of clipped) {
      if (!(visibility[c.id] ?? !c.layer.hidden)) continue;
      const cc = layerCanvas(c.layer);
      if (!cc) continue;
      drawLayer(uctx, c.layer, cc);
    }
    // Clip the whole unit back to the base layer's own alpha (blends above
    // may have painted outside it).
    uctx.globalAlpha = 1;
    uctx.globalCompositeOperation = "destination-in";
    uctx.drawImage(content, layer.left ?? 0, layer.top ?? 0);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = layer.opacity ?? 1;
    ctx.globalCompositeOperation = blendOp(layer.blendMode);
    ctx.drawImage(unit, 0, 0);
    ctx.restore();
  }
}

function drawLayer(
  ctx: OffscreenCanvasRenderingContext2D,
  layer: Layer,
  content: OffscreenCanvas
) {
  ctx.save();
  ctx.globalAlpha = (layer.opacity ?? 1) * (layer.fillOpacity ?? 1);
  ctx.globalCompositeOperation = blendOp(layer.blendMode);
  ctx.drawImage(content, layer.left ?? 0, layer.top ?? 0);
  ctx.restore();
}

/** The layer's pixels as a canvas with its raster mask already applied, or
 *  null when there is nothing to draw. Cached per layer — toggling re-blends
 *  but never re-decodes. */
function layerCanvas(layer: Layer): OffscreenCanvas | null {
  if (layerCanvasCache.has(layer)) return layerCanvasCache.get(layer)!;
  let canvas: OffscreenCanvas | null = null;
  if (layer.imageData?.data?.length) {
    canvas = toCanvas(layer.imageData);
    const mask = layer.mask;
    if (mask && !mask.disabled && mask.imageData?.data?.length) {
      applyMask(canvas, layer, mask);
    }
  }
  layerCanvasCache.set(layer, canvas);
  return canvas;
}

function applyMask(canvas: OffscreenCanvas, layer: Layer, mask: LayerMaskData) {
  const img = mask.imageData!;
  // Alpha sheet covering the layer: defaultColor outside the mask rect
  // (0 hides, 255 shows), the mask's own values inside it.
  const sheet = new OffscreenCanvas(canvas.width, canvas.height);
  const sctx = sheet.getContext("2d")!;
  sctx.fillStyle = `rgba(0,0,0,${(mask.defaultColor ?? 255) / 255})`;
  sctx.fillRect(0, 0, sheet.width, sheet.height);
  const alpha = new ImageData(img.width, img.height);
  const src = toRgba(img);
  for (let i = 0; i < img.width * img.height; i++) {
    alpha.data[i * 4 + 3] = src[i * 4]; // mask value rides the red channel
  }
  sctx.putImageData(alpha, (mask.left ?? 0) - (layer.left ?? 0), (mask.top ?? 0) - (layer.top ?? 0));
  const ctx = canvas.getContext("2d")!;
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(sheet, 0, 0);
  ctx.globalCompositeOperation = "source-over";
}

function toCanvas(img: PixelData): OffscreenCanvas {
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas.getContext("2d")!.putImageData(new ImageData(toRgba(img), img.width, img.height), 0, 0);
  return canvas;
}

/** ag-psd pixel data as 8-bit RGBA (16/32-bit depths downconverted). */
function toRgba(img: PixelData): Uint8ClampedArray<ArrayBuffer> {
  const { data } = img;
  if (data instanceof Uint8ClampedArray) return data as Uint8ClampedArray<ArrayBuffer>;
  if (data instanceof Uint8Array) {
    return new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) as Uint8ClampedArray<ArrayBuffer>;
  }
  const out = new Uint8ClampedArray(data.length);
  if (data instanceof Uint16Array) {
    for (let i = 0; i < data.length; i++) out[i] = data[i] >> 8;
  } else {
    for (let i = 0; i < data.length; i++) out[i] = (data as Float32Array)[i] * 255;
  }
  return out;
}
