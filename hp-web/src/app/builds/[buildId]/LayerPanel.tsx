"use client";

// Layer visibility panel shared by the PDF (optional content groups), PSD
// (layer stack), and SVG (top-level named groups) viewers. Floats over the
// viewer's top-right corner, collapsible to a chip; the tree is checkboxes —
// native semantics, keyboard reachable.

import { useState } from "react";

export interface LayerNode {
  id: string;
  name: string;
  visible: boolean;
  /** Listed for fidelity but not toggleable (e.g. adjustment layers the
   *  renderer can't apply). */
  disabled?: boolean;
  children?: LayerNode[];
}

/** The tree's node count — the collapsed chip shows it. */
function countLayers(nodes: LayerNode[]): number {
  return nodes.reduce((n, l) => n + 1 + countLayers(l.children ?? []), 0);
}

function LayerTree({
  nodes,
  depth,
  onToggle,
}: {
  nodes: LayerNode[];
  depth: number;
  onToggle: (id: string, visible: boolean) => void;
}) {
  return (
    <ul className={depth > 0 ? "ml-3 border-l border-neutral-800 pl-2" : ""}>
      {nodes.map((l) => (
        <li key={l.id}>
          <label
            className={`flex items-center gap-1.5 rounded px-1 py-0.5 ${
              l.disabled ? "text-neutral-500" : "cursor-pointer hover:bg-neutral-800/60"
            }`}
            title={l.disabled ? `${l.name} — not rendered` : l.name}
          >
            <input
              type="checkbox"
              checked={l.visible}
              disabled={l.disabled}
              onChange={(e) => onToggle(l.id, e.target.checked)}
              className="accent-sky-500"
            />
            <span className="min-w-0 flex-1 truncate">{l.name}</span>
          </label>
          {l.children && l.children.length > 0 && (
            <LayerTree nodes={l.children} depth={depth + 1} onToggle={onToggle} />
          )}
        </li>
      ))}
    </ul>
  );
}

export default function LayerPanel({
  layers,
  onToggle,
}: {
  layers: LayerNode[];
  onToggle: (id: string, visible: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  if (layers.length === 0) return null;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute right-2 top-2 z-10 rounded-full bg-neutral-950/80 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-white"
      >
        Layers ({countLayers(layers)})
      </button>
    );
  }

  return (
    <div className="absolute right-2 top-2 z-10 flex max-h-[calc(100%-4rem)] w-52 flex-col rounded border border-neutral-800 bg-neutral-950/90 text-xs text-neutral-200">
      <div className="flex items-center justify-between border-b border-neutral-800 px-2 py-1">
        <span className="font-semibold uppercase tracking-wide text-neutral-400">Layers</span>
        <button
          onClick={() => setOpen(false)}
          aria-label="Hide layers"
          className="rounded px-1 text-neutral-400 hover:bg-neutral-800 hover:text-white"
        >
          &times;
        </button>
      </div>
      <div className="min-h-0 overflow-auto p-1.5">
        <LayerTree nodes={layers} depth={0} onToggle={onToggle} />
      </div>
    </div>
  );
}
