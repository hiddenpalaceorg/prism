"use client";

import { useMemo, useState } from "react";
import type { Node } from "@/lib/types";

interface TreeNode {
  name: string; // basename, or "a/b/c" for a compressed single-child chain
  path: string; // full path from root
  dir: boolean;
  size?: number;
  date?: string;
  children: TreeNode[];
  fileCount: number; // directories: total files in the subtree
  totalSize: number; // directories: total bytes in the subtree
}

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

const join = (a: string, b: string) => `${a}/${b}`.replace(/\/+/g, "/");

// Directories sort first, then alphabetically (case-insensitive), like a file browser.
function compareNodes(a: Node, b: Node): number {
  if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function buildTree(nodes: Node[], prefix: string): TreeNode[] {
  return [...nodes].sort(compareNodes).map((n) => {
    const path = join(prefix, n.name);
    if (n.type !== "dir") {
      return { name: n.name, path, dir: false, size: n.size, date: n.date, children: [], fileCount: 0, totalSize: n.size ?? 0 };
    }
    // Collapse chains of single-child directories into one row (a/b/c).
    let name = n.name;
    let cur = path;
    let date = n.date;
    let children = n.children;
    while (children.length === 1 && children[0].type === "dir") {
      const only = children[0];
      name = join(name, only.name);
      cur = join(cur, only.name);
      date = only.date ?? date;
      children = only.children;
    }
    const built = buildTree(children, cur);
    const fileCount = built.reduce((acc, c) => acc + (c.dir ? c.fileCount : 1), 0);
    const totalSize = built.reduce((acc, c) => acc + (c.dir ? c.totalSize : c.size ?? 0), 0);
    return { name, path: cur, dir: true, date, children: built, fileCount, totalSize };
  });
}

// Expand greedily, depth-first, until roughly `budget` rows would be visible — so small
// builds open fully while huge ones start mostly collapsed.
function initialExpanded(roots: TreeNode[], budget = 200): Set<string> {
  const set = new Set<string>();
  let count = 0;
  const visit = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (count++ > budget) return;
      if (n.dir && n.children.length) {
        set.add(n.path);
        visit(n.children);
      }
    }
  };
  visit(roots);
  return set;
}

function collectDirPaths(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.dir) {
      out.push(n.path);
      collectDirPaths(n.children, out);
    }
  }
  return out;
}

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

export default function FileTree({ nodes }: { nodes: Node[] }) {
  const tree = useMemo(() => buildTree(nodes, ""), [nodes]);
  const allDirs = useMemo(() => collectDirPaths(tree), [tree]);
  const [expanded, setExpanded] = useState<Set<string>>(() => initialExpanded(tree));

  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <>
      <div className="mt-3 flex gap-3 text-xs text-neutral-500">
        <button className="hover:underline" onClick={() => setExpanded(new Set(allDirs))}>
          Expand all
        </button>
        <button className="hover:underline" onClick={() => setExpanded(new Set())}>
          Collapse all
        </button>
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
                    onClick={() => toggle(node.path)}
                    className="flex w-full min-w-0 items-center gap-1 text-left text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
                  >
                    <span className="w-3 shrink-0 text-[10px]">{open ? "▾" : "▸"}</span>
                    <span className="truncate">{node.name}/</span>
                    <span className="shrink-0 text-xs text-neutral-400">({node.fileCount})</span>
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
    </>
  );
}
