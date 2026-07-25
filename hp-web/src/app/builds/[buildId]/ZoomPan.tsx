"use client";

// Shared zoom/pan viewport for the asset viewers (images, SVG, PDF, PSD).
//
// Zoom works by layout size, not CSS transform: the child renders itself at
// `width * scale` real pixels (an <svg> re-tessellates, a PDF canvas
// re-rasterizes, an <img> resamples), so content stays sharp at any zoom
// where a transform would show a stretched stale raster. The child is a
// render prop receiving the current scale.

import { useCallback, useEffect, useRef, useState } from "react";

const MAX_SCALE = 64;

// Wheel deltas per zoom e-fold; trackpad pinches arrive as ctrlKey wheels
// with small deltas and want a stronger response.
const WHEEL_K = 0.0015;
const PINCH_K = 0.01;

interface View {
  scale: number;
  tx: number;
  ty: number;
}

export default function ZoomPan({
  contentSize,
  children,
  onScaleSettled,
  className,
}: {
  /** Natural pixel size of the content at scale 1. */
  contentSize: { width: number; height: number };
  /** Renders the content at the given scale (i.e. width*scale CSS px wide). */
  children: (scale: number) => React.ReactNode;
  /** Fires once zooming has been idle briefly — for renderers that want to
   *  re-rasterize at the settled scale (PDF). */
  onScaleSettled?: (scale: number) => void;
  className?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View | null>(null); // null until first fit
  // Live pointer state stays out of React state — pans happen per pointermove.
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  const fit = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const scale = Math.min(
      vp.clientWidth / contentSize.width,
      vp.clientHeight / contentSize.height,
      1
    );
    setView({
      scale,
      tx: (vp.clientWidth - contentSize.width * scale) / 2,
      ty: (vp.clientHeight - contentSize.height * scale) / 2,
    });
  }, [contentSize.width, contentSize.height]);

  useEffect(fit, [fit]);

  /** Rescale anchored at viewport point (px, py). */
  const zoomAt = useCallback(
    (factor: number, px: number, py: number) => {
      setView((v) => {
        if (!v) return v;
        const vp = viewportRef.current;
        const minScale = vp
          ? Math.min(
              vp.clientWidth / contentSize.width,
              vp.clientHeight / contentSize.height,
              1
            ) / 8
          : 0.01;
        const scale = Math.min(MAX_SCALE, Math.max(minScale, v.scale * factor));
        const k = scale / v.scale;
        return { scale, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
      });
    },
    [contentSize.width, contentSize.height]
  );

  // Wheel must be a non-passive listener — React's synthetic onWheel can't
  // preventDefault, and the page would scroll under the lightbox.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      const k = e.ctrlKey ? PINCH_K : WHEEL_K;
      zoomAt(Math.exp(-e.deltaY * k), e.clientX - r.left, e.clientY - r.top);
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    if (!onScaleSettled || !view) return;
    const t = window.setTimeout(() => onScaleSettled(view.scale), 200);
    return () => window.clearTimeout(t);
  }, [view, onScaleSettled]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointers.current.get(e.pointerId);
    if (!p) return;
    const next = { x: e.clientX, y: e.clientY };
    if (pointers.current.size === 1) {
      const dx = next.x - p.x;
      const dy = next.y - p.y;
      pointers.current.set(e.pointerId, next);
      setView((v) => (v ? { ...v, tx: v.tx + dx, ty: v.ty + dy } : v));
      return;
    }
    if (pointers.current.size === 2) {
      // Pinch: rescale by the change in pointer distance, anchored and
      // panned at/by the midpoint.
      const [a0, b0] = [...pointers.current.values()];
      pointers.current.set(e.pointerId, next);
      const [a1, b1] = [...pointers.current.values()];
      const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y);
      const d1 = Math.hypot(a1.x - b1.x, a1.y - b1.y);
      const r = viewportRef.current?.getBoundingClientRect();
      if (!r || d0 === 0) return;
      const mx = (a1.x + b1.x) / 2 - r.left;
      const my = (a1.y + b1.y) / 2 - r.top;
      const pmx = (a0.x + b0.x) / 2 - r.left;
      const pmy = (a0.y + b0.y) / 2 - r.top;
      setView((v) => (v ? { ...v, tx: v.tx + mx - pmx, ty: v.ty + my - pmy } : v));
      zoomAt(d1 / d0, mx, my);
    }
  };

  const zoomCenter = (factor: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    zoomAt(factor, vp.clientWidth / 2, vp.clientHeight / 2);
  };
  const actualSize = () => {
    const vp = viewportRef.current;
    if (!vp || !view) return;
    // Keep the viewport center pointed at the same content pixel.
    zoomAt(1 / view.scale, vp.clientWidth / 2, vp.clientHeight / 2);
  };

  return (
    <div className={`relative overflow-hidden ${className ?? ""}`}>
      <div
        ref={viewportRef}
        className="absolute inset-0 cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={fit}
      >
        {view && (
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{
              transform: `translate(${view.tx}px, ${view.ty}px)`,
              width: contentSize.width * view.scale,
              height: contentSize.height * view.scale,
            }}
          >
            {children(view.scale)}
          </div>
        )}
      </div>

      <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-neutral-950/80 px-2 py-1 text-xs text-neutral-300">
        <button
          onClick={() => zoomCenter(1 / 1.5)}
          aria-label="Zoom out"
          className="rounded px-1.5 hover:bg-neutral-800 hover:text-white"
        >
          &minus;
        </button>
        <span className="min-w-11 text-center tabular-nums">
          {view ? `${Math.round(view.scale * 100)}%` : ""}
        </span>
        <button
          onClick={() => zoomCenter(1.5)}
          aria-label="Zoom in"
          className="rounded px-1.5 hover:bg-neutral-800 hover:text-white"
        >
          +
        </button>
        <button onClick={fit} className="rounded px-1.5 hover:bg-neutral-800 hover:text-white">
          Fit
        </button>
        <button onClick={actualSize} className="rounded px-1.5 hover:bg-neutral-800 hover:text-white">
          1:1
        </button>
      </div>
    </div>
  );
}
