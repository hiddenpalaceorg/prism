"use client";

// Inline SVG viewer: the asset's markup is sanitized (DOMPurify, svg profile —
// scripts, handlers, and foreignObject stripped) and mounted as a real <svg>
// element, so the browser re-tessellates on every zoom instead of scaling a
// raster. Editors write layers as top-level groups (Inkscape: inkscape:label,
// Illustrator: data-name) — when a document has two or more, they become
// toggles. Anything that fails to parse falls back to the parent's plain
// <img> rendering, where SVG is safe by construction.

import DOMPurify from "dompurify";
import { useCallback, useEffect, useState } from "react";
import LayerPanel, { type LayerNode } from "./LayerPanel";
import ZoomPan from "./ZoomPan";

interface ParsedSvg {
  el: SVGSVGElement;
  width: number;
  height: number;
  groups: { id: string; name: string; el: SVGGElement }[];
}

function groupName(g: SVGGElement): string | null {
  return (
    g.getAttribute("inkscape:label") ||
    g.getAttribute("data-name") ||
    g.querySelector(":scope > title")?.textContent?.trim() ||
    g.getAttribute("id") ||
    null
  );
}

function parseSvg(markup: string): ParsedSvg | null {
  const clean = DOMPurify.sanitize(markup, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_ATTR: ["inkscape:label", "inkscape:groupmode"],
  });
  const doc = new DOMParser().parseFromString(clean, "image/svg+xml");
  const el = doc.documentElement;
  if (!(el instanceof SVGSVGElement)) return null;

  // Natural size: viewBox first (unit-true), else width/height attributes
  // (parseFloat shrugs off pt/mm suffixes — close enough for a fit scale).
  let width = 0;
  let height = 0;
  const vb = el.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) {
    width = vb.width;
    height = vb.height;
  } else {
    width = parseFloat(el.getAttribute("width") ?? "") || 0;
    height = parseFloat(el.getAttribute("height") ?? "") || 0;
    if (width > 0 && height > 0) el.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  if (!(width > 0 && height > 0)) return null;

  // Fill the ZoomPan wrapper, which carries the scaled pixel size.
  el.setAttribute("width", "100%");
  el.setAttribute("height", "100%");
  el.removeAttribute("style");

  const groups = [...el.children]
    .filter((c): c is SVGGElement => c.tagName.toLowerCase() === "g")
    .flatMap((g, i) => {
      const name = groupName(g);
      return name ? [{ id: `g${i}`, name, el: g }] : [];
    });

  return { el, width, height, groups };
}

export default function SvgViewer({
  url,
  label,
  onUnavailable,
}: {
  url: string;
  label: string;
  /** Fetch/parse failed — parent falls back to plain <img> rendering. */
  onUnavailable: () => void;
}) {
  const [svg, setSvg] = useState<ParsedSvg | null>(null);
  const [layers, setLayers] = useState<LayerNode[]>([]);

  // Callback ref, not an effect: the host div only mounts once ZoomPan has
  // measured its fit scale, which is after the svg state lands.
  const mountSvg = useCallback(
    (host: HTMLDivElement | null) => {
      if (host && svg) host.replaceChildren(svg.el);
    },
    [svg]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseSvg(await res.text());
        if (cancelled) return;
        if (!parsed) {
          onUnavailable();
          return;
        }
        setSvg(parsed);
        if (parsed.groups.length >= 2) {
          setLayers(parsed.groups.map(({ id, name }) => ({ id, name, visible: true })));
        }
      } catch {
        if (!cancelled) onUnavailable();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const toggleLayer = (id: string, visible: boolean) => {
    const group = svg?.groups.find((g) => g.id === id);
    if (group) group.el.style.display = visible ? "" : "none";
    setLayers((l) => l.map((n) => (n.id === id ? { ...n, visible } : n)));
  };

  if (!svg) {
    return <p className="p-6 text-sm text-neutral-400">Loading…</p>;
  }

  return (
    <div className="relative h-[75vh] w-[min(85rem,92vw)]">
      <ZoomPan
        contentSize={{ width: svg.width, height: svg.height }}
        className="h-full w-full rounded bg-neutral-900"
      >
        {() => <div ref={mountSvg} role="img" aria-label={label} className="h-full w-full" />}
      </ZoomPan>
      <LayerPanel layers={layers} onToggle={toggleLayer} />
    </div>
  );
}
