"use client";

// Photoshop document viewer: the raw PSD/PSB is fetched once and handed to a
// worker (psd.worker.ts) that parses it with ag-psd and composites the
// visible layers off-thread; this component owns the layer tree UI and blits
// each composited frame onto a canvas inside the shared ZoomPan. Files the
// worker can't handle (exotic color modes, oversized) fall back to the
// server's flattened /png conversion via onUnavailable.

import { useCallback, useEffect, useRef, useState } from "react";
import LayerPanel, { type LayerNode } from "./LayerPanel";
import ZoomPan from "./ZoomPan";
import type { WorkerLayer } from "./psd.worker";

type WorkerOut =
  | { type: "loaded"; width: number; height: number; layers: WorkerLayer[] }
  | { type: "frame"; bitmap: ImageBitmap }
  | { type: "error"; message: string };

/** id → effective visibility for every node (the worker skips invisible
 *  subtrees itself; this map just mirrors each node's own checkbox). */
function visibilityMap(nodes: LayerNode[], out: Record<string, boolean> = {}) {
  for (const n of nodes) {
    out[n.id] = n.visible;
    if (n.children) visibilityMap(n.children, out);
  }
  return out;
}

function setNodeVisible(nodes: LayerNode[], id: string, visible: boolean): LayerNode[] {
  return nodes.map((n) => ({
    ...n,
    visible: n.id === id ? visible : n.visible,
    children: n.children ? setNodeVisible(n.children, id, visible) : undefined,
  }));
}

export default function PsdViewer({
  url,
  label,
  onUnavailable,
}: {
  url: string;
  label: string;
  /** Parse/composite failed — parent falls back to the server-flattened PNG. */
  onUnavailable: () => void;
}) {
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  // A frame can arrive before ZoomPan has measured its fit scale and rendered
  // the canvas — park it here and paint on attach.
  const pendingFrame = useRef<ImageBitmap | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [layers, setLayers] = useState<LayerNode[]>([]);
  const [painted, setPainted] = useState(false);

  const paint = useCallback((bitmap: ImageBitmap) => {
    const canvas = canvasElRef.current;
    if (!canvas) {
      pendingFrame.current?.close();
      pendingFrame.current = bitmap;
      return;
    }
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    setPainted(true);
  }, []);

  const canvasRef = useCallback(
    (node: HTMLCanvasElement | null) => {
      canvasElRef.current = node;
      if (node && pendingFrame.current) {
        const bitmap = pendingFrame.current;
        pendingFrame.current = null;
        paint(bitmap);
      }
    },
    [paint]
  );

  useEffect(() => {
    let cancelled = false;
    const worker = new Worker(new URL("./psd.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      if (cancelled) return;
      const msg = e.data;
      if (msg.type === "loaded") {
        setSize({ width: msg.width, height: msg.height });
        setLayers(msg.layers);
        worker.postMessage({ type: "render", visibility: visibilityMap(msg.layers) });
      } else if (msg.type === "frame") {
        paint(msg.bitmap);
      } else {
        onUnavailable();
      }
    };
    worker.onerror = () => {
      if (!cancelled) onUnavailable();
    };
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (!cancelled) worker.postMessage({ type: "load", buf }, [buf]);
      } catch {
        if (!cancelled) onUnavailable();
      }
    })();
    return () => {
      cancelled = true;
      worker.terminate();
      workerRef.current = null;
      pendingFrame.current?.close();
      pendingFrame.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const toggleLayer = (id: string, visible: boolean) => {
    setLayers((prev) => {
      const next = setNodeVisible(prev, id, visible);
      workerRef.current?.postMessage({ type: "render", visibility: visibilityMap(next) });
      return next;
    });
  };

  if (!size) {
    return <p className="p-6 text-sm text-neutral-400">Loading layers…</p>;
  }

  return (
    <div className="relative h-[75vh] w-[min(85rem,92vw)]">
      <ZoomPan contentSize={size} className="h-full w-full rounded bg-neutral-900">
        {(scale) => (
          <canvas
            ref={canvasRef}
            aria-label={label}
            className={`h-full w-full ${painted ? "" : "invisible"}`}
            // Game art wants crisp texels when magnified, smooth minification
            // otherwise.
            style={{ imageRendering: scale > 1 ? "pixelated" : "auto" }}
          />
        )}
      </ZoomPan>
      {!painted && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-400">
          Compositing…
        </span>
      )}
      <LayerPanel layers={layers} onToggle={toggleLayer} />
    </div>
  );
}
