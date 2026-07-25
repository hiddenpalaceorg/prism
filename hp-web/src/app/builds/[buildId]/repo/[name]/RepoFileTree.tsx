"use client";

// The repo file tree at one revision — FileTree.tsx adapted: rows open files
// in the repo viewer instead of the asset lightbox, and it's a compact
// name-only tree (git trees carry no dates, and sizes live in the file view).
// The parent remounts this per revision (key={revOid}) with that snapshot's
// roots; collapsed stubs lazy-load their children from /api/repo/<sha>/tree.

import { useCallback, useState } from "react";
import {
  collectDirPaths,
  findByPath,
  fullyLoaded,
  graftChildren,
  type TreeNode,
} from "@/lib/filetree";
import { normalizeAssetPath } from "@/lib/slug";

// Fixed row height so a folder's sticky `top` can be offset by its depth (the
// ancestor chain stacks at the top of the scroll container).
const ROW_H = 24;

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

export default function RepoFileTree({
  apiBase,
  revOid,
  roots,
  initiallyExpanded,
  selectedPath,
  onOpenFile,
}: {
  apiBase: string;
  revOid: string;
  roots: TreeNode[];
  initiallyExpanded: string[];
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
}) {
  const [tree, setTree] = useState<TreeNode[]>(roots);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initiallyExpanded));
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

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
          const res = await fetch(`${apiBase}/tree?rev=${revOid}&path=${encodeURIComponent(path)}`);
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
    [expanded, tree, loading, apiBase, revOid]
  );

  const [expandingAll, setExpandingAll] = useState(false);
  const expandAll = useCallback(async () => {
    let full = tree;
    if (!fullyLoaded(tree)) {
      setExpandingAll(true);
      try {
        const res = await fetch(`${apiBase}/tree?rev=${revOid}`);
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
  }, [tree, apiBase, revOid]);

  return (
    <>
      <div className="flex gap-3 px-2 py-1.5 text-xs text-neutral-500">
        <button className="hover:underline disabled:opacity-50" onClick={() => void expandAll()} disabled={expandingAll}>
          {expandingAll ? "Expanding…" : "Expand all"}
        </button>
        <button className="hover:underline" onClick={() => setExpanded(new Set())}>
          Collapse all
        </button>
        {error && <span className="text-red-500">{error}</span>}
      </div>
      <div>
        {rows.map(({ node, depth }) => {
          const open = expanded.has(node.path);
          const busy = loading.has(node.path);
          const selected = !node.dir && normalizeAssetPath(node.path) === selectedPath;
          return (
            <div
              key={node.path}
              className={`flex items-center border-b border-neutral-100 text-xs hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900/40 ${
                node.dir ? "bg-white dark:bg-neutral-950" : selected ? "bg-sky-50 dark:bg-sky-950/40" : ""
              }`}
              style={
                node.dir
                  ? { height: ROW_H, position: "sticky", top: depth * ROW_H, zIndex: 60 - depth }
                  : { height: ROW_H }
              }
            >
              <div className="min-w-0 flex-1 font-mono" style={{ paddingLeft: depth * 12 + 8, paddingRight: 8 }}>
                {node.dir ? (
                  <button
                    onClick={() => void toggle(node.path)}
                    className="flex w-full min-w-0 items-center gap-1 text-left text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
                  >
                    <span className="w-3 shrink-0 text-[10px]">{busy ? "⋯" : open ? "▾" : "▸"}</span>
                    <span className="truncate">{node.name}/</span>
                    <span className="shrink-0 text-[10px] text-neutral-400">({node.fileCount})</span>
                  </button>
                ) : (
                  <button
                    onClick={() => onOpenFile(normalizeAssetPath(node.path))}
                    title={`View ${node.name}`}
                    className={`block w-full min-w-0 truncate pl-4 text-left hover:underline ${
                      selected ? "font-medium text-sky-800 dark:text-sky-300" : "text-sky-700 dark:text-sky-400"
                    }`}
                  >
                    {node.name}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
