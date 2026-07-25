"use client";

// Client-side PDF rendering with pdf.js: unlike the old <object> embed this
// works everywhere (mobile included), re-rasterizes at the zoomed scale so
// vector art stays sharp, and exposes the document's optional content groups
// — the layer mechanism Illustrator writes when saving PDF-compatible .ai —
// as toggles. PostScript/EPS assets arrive here through the server's
// /pdf conversion (Ghostscript pdfwrite), vectors intact.

import { useCallback, useEffect, useRef, useState } from "react";
import LayerPanel, { type LayerNode } from "./LayerPanel";
import ZoomPan from "./ZoomPan";

type PdfJs = typeof import("pdfjs-dist");
type PdfDocument = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>;
type OptionalContent = Awaited<ReturnType<PdfDocument["getOptionalContentConfig"]>>;

// pdf.js scale 1 is 72dpi points; CSS lays pages out at 96dpi. Rendering with
// this factor folded in makes "100%" mean natural print size on screen.
const PDF_TO_CSS = 96 / 72;

// Backing-store budget per render — beyond it the canvas is rendered smaller
// than the layout box and CSS-upscaled (deep zoom on a huge page).
const MAX_RENDER_PIXELS = 24_000_000;

// The module and its worker load once per session, on first use.
let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerSrc = "/api/pdfjs/build/pdf.worker.min.mjs";
    return m;
  });
  return pdfjsPromise;
}

/** The optional-content order tree as LayerNodes. Entries are group ids or
 *  `{name, order}` sub-arrays (nested layer sets). */
function layerTree(occ: OptionalContent, order: unknown[] | null): LayerNode[] {
  if (!order) return [];
  const nodes: LayerNode[] = [];
  for (const entry of order) {
    if (typeof entry === "string") {
      const group = occ.getGroup(entry) as { name?: string | null; visible?: boolean } | null;
      nodes.push({
        id: entry,
        name: group?.name || "Unnamed layer",
        visible: group?.visible !== false,
      });
    } else if (entry && typeof entry === "object" && "order" in entry) {
      const sub = entry as { name?: string | null; order: unknown[] };
      const children = layerTree(occ, sub.order);
      if (children.length > 0) {
        nodes.push({
          id: `set:${nodes.length}:${sub.name ?? ""}`,
          name: sub.name || "Layer set",
          visible: children.some((c) => c.visible),
          disabled: true, // the set itself has no OCG id to toggle
          children,
        });
      }
    }
  }
  return nodes;
}

function setNodeVisible(nodes: LayerNode[], id: string, visible: boolean): LayerNode[] {
  return nodes.map((n) => ({
    ...n,
    visible: n.id === id ? visible : n.visible,
    children: n.children ? setNodeVisible(n.children, id, visible) : undefined,
  }));
}

export default function PdfViewer({
  url,
  label,
  onUnavailable,
}: {
  url: string;
  label: string;
  /** The document can't be fetched or parsed — parent picks the fallback. */
  onUnavailable: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<PdfDocument | null>(null);
  const pageRef = useRef<PdfPage | null>(null);
  const occRef = useRef<OptionalContent | null>(null);
  // Monotonic render generation: a stale async render must never paint over a
  // newer one (zoom settled twice, page flipped mid-render).
  const renderGen = useRef(0);
  const lastScale = useRef(1);

  const [pageState, setPageState] = useState<{
    num: number;
    count: number;
    width: number;
    height: number;
  } | null>(null);
  const [layers, setLayers] = useState<LayerNode[]>([]);
  const [painted, setPainted] = useState(false);

  const render = useCallback(async (scale: number) => {
    const page = pageRef.current;
    const canvas = canvasRef.current;
    if (!page || !canvas) return;
    lastScale.current = scale;
    const gen = ++renderGen.current;

    let pixelScale = scale * PDF_TO_CSS * Math.min(window.devicePixelRatio || 1, 2);
    const base = page.getViewport({ scale: PDF_TO_CSS });
    if (base.width * base.height * (pixelScale / PDF_TO_CSS) ** 2 > MAX_RENDER_PIXELS) {
      pixelScale = PDF_TO_CSS * Math.sqrt(MAX_RENDER_PIXELS / (base.width * base.height));
    }
    const viewport = page.getViewport({ scale: pixelScale });

    // Render offscreen and blit, so the visible canvas never blanks while a
    // zoomed re-render is in flight.
    const tmp = document.createElement("canvas");
    tmp.width = Math.ceil(viewport.width);
    tmp.height = Math.ceil(viewport.height);
    try {
      const occ = occRef.current;
      await page.render({
        canvas: tmp,
        viewport,
        ...(occ ? { optionalContentConfigPromise: Promise.resolve(occ) } : {}),
      }).promise;
    } catch {
      return; // cancelled or render error — a newer render owns the canvas
    }
    if (gen !== renderGen.current) return;
    canvas.width = tmp.width;
    canvas.height = tmp.height;
    canvas.getContext("2d")!.drawImage(tmp, 0, 0);
    setPainted(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let doc: PdfDocument | null = null;
    const gen = renderGen;
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        doc = await pdfjs.getDocument({
          url,
          cMapUrl: "/api/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/api/pdfjs/standard_fonts/",
          wasmUrl: "/api/pdfjs/wasm/",
        }).promise;
        if (cancelled) return;
        docRef.current = doc;
        const [page, occ] = await Promise.all([
          doc.getPage(1),
          doc.getOptionalContentConfig(),
        ]);
        if (cancelled) return;
        pageRef.current = page;
        occRef.current = occ;
        setLayers(layerTree(occ, occ.getOrder()));
        const vp = page.getViewport({ scale: PDF_TO_CSS });
        setPageState({ num: 1, count: doc.numPages, width: vp.width, height: vp.height });
      } catch {
        if (!cancelled) onUnavailable();
      }
    })();
    return () => {
      cancelled = true;
      gen.current++; // invalidate any in-flight render
      doc?.loadingTask.destroy().catch(() => {});
      docRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const goToPage = async (num: number) => {
    const doc = docRef.current;
    if (!doc || !pageState || num < 1 || num > pageState.count) return;
    const page = await doc.getPage(num);
    if (docRef.current !== doc) return;
    pageRef.current = page;
    const vp = page.getViewport({ scale: PDF_TO_CSS });
    setPageState({ num, count: pageState.count, width: vp.width, height: vp.height });
    render(lastScale.current);
  };

  const toggleLayer = (id: string, visible: boolean) => {
    occRef.current?.setVisibility(id, visible);
    setLayers((l) => setNodeVisible(l, id, visible));
    render(lastScale.current);
  };

  if (!pageState) {
    return <p className="p-6 text-sm text-neutral-400">Loading document…</p>;
  }

  return (
    <div className="relative h-[75vh] w-[min(85rem,92vw)]">
      <ZoomPan
        contentSize={{ width: pageState.width, height: pageState.height }}
        onScaleSettled={render}
        className="h-full w-full rounded bg-neutral-900"
      >
        {() => (
          <canvas
            ref={canvasRef}
            aria-label={label}
            className={`h-full w-full bg-white ${painted ? "" : "invisible"}`}
          />
        )}
      </ZoomPan>
      {!painted && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-400">
          Rendering…
        </span>
      )}
      {pageState.count > 1 && (
        <div className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded-full bg-neutral-950/80 px-2 py-1 text-xs text-neutral-300">
          <button
            onClick={() => goToPage(pageState.num - 1)}
            disabled={pageState.num <= 1}
            aria-label="Previous page"
            className="rounded px-1 hover:bg-neutral-800 hover:text-white disabled:opacity-40"
          >
            ‹
          </button>
          <span className="tabular-nums">
            {pageState.num} / {pageState.count}
          </span>
          <button
            onClick={() => goToPage(pageState.num + 1)}
            disabled={pageState.num >= pageState.count}
            aria-label="Next page"
            className="rounded px-1 hover:bg-neutral-800 hover:text-white disabled:opacity-40"
          >
            ›
          </button>
        </div>
      )}
      <LayerPanel layers={layers} onToggle={toggleLayer} />
    </div>
  );
}
