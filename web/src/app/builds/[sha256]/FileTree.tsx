"use client";

import { useCallback, useMemo, useState } from "react";
import {
  collectDirPaths,
  findByPath,
  fullyLoaded,
  graftChildren,
  type TreeNode,
} from "@/lib/filetree";
import AssetViewer, { type ViewableAsset } from "./AssetViewer";

// Chip label on viewable file rows, by asset kind.
const KIND_TAG: Record<string, string> = { image: "img", audio: "aud", video: "vid", source: "src", text: "txt" };

function humanSize(bytes?: number): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${bytes} B` : `${v.toFixed(1)} ${units[i]}`;
}

function formatDate(date?: string): string {
  if (!date) return "—";
  const m = date.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : date;
}

// Fixed row height so a folder's sticky `top` can be offset by its depth, letting the
// whole ancestor chain stack at the top as you scroll through its contents.
const ROW_H = 28;
const HEADER_H = 28;

interface Row {
  node: TreeNode;
  depth: number;
}

function visibleRows(nodes: TreeNode[], expanded: Set<string>, depth = 0, out: Row[] = []): Row[] {
  for (const n of nodes) {
    out.push({ node: n, depth });
    if (n.dir && expanded.has(n.path)) visibleRows(n.children, expanded, depth + 1, out);
  }
  return out;
}

// The server ships only the initially-visible subtree (collapsed dirs are
// stubs carrying their aggregates); expanding a stub fetches its children from
// /api/build/<sha256>/tree. "Expand all" fetches the full tree once.
export default function FileTree({
  sha256,
  roots,
  initiallyExpanded,
  assets,
}: {
  sha256: string;
  roots: TreeNode[];
  initiallyExpanded: string[];
  /** The build's viewable assets, path-ordered (see getBuildAssets). */
  assets: ViewableAsset[];
}) {
  const [tree, setTree] = useState<TreeNode[]>(roots);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initiallyExpanded));
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Index into `assets` of the file open in the viewer overlay, if any.
  const [viewing, setViewing] = useState<number | null>(null);
  const assetIndexByPath = useMemo(
    () => new Map(assets.map((a, i) => [a.path, i] as const)),
    [assets]
  );

  const rows = visibleRows(tree, expanded);

  const setBusy = (path: string, busy: boolean) =>
    setLoading((prev) => {
      const next = new Set(prev);
      if (busy) next.add(path);
      else next.delete(path);
      return next;
    });

  const toggle = useCallback(
    async (path: string) => {
      if (expanded.has(path)) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
        return;
      }
      const node = findByPath(tree, path);
      if (!node || !node.dir) return;
      if (!node.loaded) {
        if (loading.has(path)) return;
        setBusy(path, true);
        try {
          const res = await fetch(`/api/build/${sha256}/tree?path=${encodeURIComponent(path)}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data: { children: TreeNode[] } = await res.json();
          setTree((prev) => graftChildren(prev, path, data.children));
          setError(null);
        } catch {
          setError("Failed to load folder contents — try again.");
          return;
        } finally {
          setBusy(path, false);
        }
      }
      setExpanded((prev) => new Set(prev).add(path));
    },
    [expanded, tree, loading, sha256]
  );

  const [expandingAll, setExpandingAll] = useState(false);
  const expandAll = useCallback(async () => {
    let full = tree;
    if (!fullyLoaded(tree)) {
      setExpandingAll(true);
      try {
        const res = await fetch(`/api/build/${sha256}/tree`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: { roots: TreeNode[] } = await res.json();
        full = data.roots;
        setTree(full);
        setError(null);
      } catch {
        setError("Failed to load the full tree — try again.");
        return;
      } finally {
        setExpandingAll(false);
      }
    }
    setExpanded(new Set(collectDirPaths(full)));
  }, [tree, sha256]);

  return (
    <>
      <div className="mt-3 flex gap-3 text-xs text-neutral-500">
        <button className="hover:underline disabled:opacity-50" onClick={() => void expandAll()} disabled={expandingAll}>
          {expandingAll ? "Expanding…" : "Expand all"}
        </button>
        <button className="hover:underline" onClick={() => setExpanded(new Set())}>
          Collapse all
        </button>
        {error && <span className="text-red-500">{error}</span>}
      </div>
      <div className="mt-2">
        <div
          className="sticky top-0 z-[70] flex items-center border-b border-neutral-200 bg-white text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950"
          style={{ height: HEADER_H }}
        >
          <span className="min-w-0 flex-1 px-3 font-medium">Name</span>
          <span className="w-24 shrink-0 px-3 text-right font-medium">Size</span>
          <span className="w-44 shrink-0 px-3 font-medium">Modified</span>
        </div>
        {rows.map(({ node, depth }) => {
          const open = expanded.has(node.path);
          const busy = loading.has(node.path);
          const assetIdx = node.dir ? undefined : assetIndexByPath.get(node.path);
          return (
            <div
              key={node.path}
              className={`flex items-center border-b border-neutral-100 text-sm hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900/40 ${
                node.dir ? "bg-white dark:bg-neutral-950" : ""
              }`}
              style={
                node.dir
                  ? { height: ROW_H, position: "sticky", top: HEADER_H + depth * ROW_H, zIndex: 60 - depth }
                  : { height: ROW_H }
              }
            >
              <div
                className="min-w-0 flex-1 font-mono"
                style={{ paddingLeft: depth * 16 + 12, paddingRight: 12 }}
              >
                {node.dir ? (
                  <button
                    onClick={() => void toggle(node.path)}
                    className="flex w-full min-w-0 items-center gap-1 text-left text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
                  >
                    <span className="w-3 shrink-0 text-[10px]">{busy ? "⋯" : open ? "▾" : "▸"}</span>
                    <span className="truncate">{node.name}/</span>
                    <span className="shrink-0 text-xs text-neutral-400">({node.fileCount})</span>
                  </button>
                ) : assetIdx !== undefined ? (
                  <button
                    onClick={() => setViewing(assetIdx)}
                    title={`View ${node.name}`}
                    className="flex w-full min-w-0 items-center gap-1.5 pl-4 text-left text-sky-700 hover:underline dark:text-sky-400"
                  >
                    <span className="truncate">{node.name}</span>
                    <span className="shrink-0 rounded bg-neutral-100 px-1 text-[10px] uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                      {KIND_TAG[assets[assetIdx].kind] ?? assets[assetIdx].kind}
                    </span>
                  </button>
                ) : (
                  <span className="block truncate pl-4">{node.name}</span>
                )}
              </div>
              <span className="w-24 shrink-0 px-3 text-right tabular-nums text-neutral-500">
                {humanSize(node.dir ? node.totalSize : node.size)}
              </span>
              <span className="w-44 shrink-0 whitespace-nowrap px-3 font-mono text-xs text-neutral-500">
                {formatDate(node.date)}
              </span>
            </div>
          );
        })}
      </div>
      {viewing !== null && assets[viewing] && (
        <AssetViewer
          assets={assets}
          index={viewing}
          onClose={() => setViewing(null)}
          onNavigate={setViewing}
        />
      )}
    </>
  );
}
