// Display-tree logic for a build's contents, shared by the build page (server),
// the lazy subtree API route, and the FileTree client component. Pure data +
// tree walks — no DB, no React.
//
// The server builds the full tree, decides the initially-expanded set, and
// ships only the nodes needed to render that (collapsed dirs become stubs that
// keep their subtree aggregates but drop their children). The client fetches a
// stub's children on first expand. This keeps the RSC payload proportional to
// what's on screen — a 48k-file build's raw contents is ~13MB of JSON, which
// used to ride along in full as client-component props.

import type { Node } from "./types";

export interface TreeNode {
  name: string; // basename, or "a/b/c" for a compressed single-child chain
  path: string; // full path from root
  dir: boolean;
  size?: number;
  date?: string;
  children: TreeNode[];
  fileCount: number; // directories: total files in the subtree
  totalSize: number; // directories: total bytes in the subtree
  /** Directories: children present. False = stub; fetch children on expand. */
  loaded: boolean;
}

const join = (a: string, b: string) => `${a}/${b}`.replace(/\/+/g, "/");

// Directories sort first, then alphabetically (case-insensitive), like a file browser.
function compareNodes(a: Node, b: Node): number {
  if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export function buildTree(nodes: Node[], prefix = ""): TreeNode[] {
  return [...nodes].sort(compareNodes).map((n) => {
    const path = join(prefix, n.name);
    if (n.type !== "dir") {
      return { name: n.name, path, dir: false, size: n.size, date: n.date, children: [], fileCount: 0, totalSize: n.size ?? 0, loaded: true };
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
    return { name, path: cur, dir: true, date, children: built, fileCount, totalSize, loaded: true };
  });
}

// Expand greedily, depth-first, until roughly `budget` rows would be visible — so small
// builds open fully while huge ones start mostly collapsed.
export function initialExpanded(roots: TreeNode[], budget = 200): Set<string> {
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

/** Total files/dirs in the (fully-loaded) tree — for the section header. */
export function treeCounts(roots: TreeNode[]): { files: number; dirs: number } {
  let files = 0;
  let dirs = 0;
  const visit = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.dir) {
        dirs++;
        visit(n.children);
      } else files++;
    }
  };
  visit(roots);
  return { files, dirs };
}

/** A dir's children with grandchildren stripped: child dirs keep their
 *  aggregates but become stubs (one fetch per expand). */
export function stubChildren(children: TreeNode[]): TreeNode[] {
  return children.map((c) => (c.dir ? { ...c, children: [], loaded: false } : c));
}

/** The subtree needed to render `expanded`: expanded dirs keep (recursively
 *  pruned) children; collapsed dirs become stubs. Input is not mutated. */
export function pruneToExpanded(roots: TreeNode[], expanded: Set<string>): TreeNode[] {
  return roots.map((n) => {
    if (!n.dir) return n;
    if (!expanded.has(n.path)) return { ...n, children: [], loaded: false };
    return { ...n, children: pruneToExpanded(n.children, expanded) };
  });
}

/** Find a node by its display path (paths embed collapsed chains, so exact
 *  match against node.path with prefix descent). */
export function findByPath(roots: TreeNode[], path: string): TreeNode | null {
  for (const n of roots) {
    if (n.path === path) return n;
    if (n.dir && path.startsWith(n.path + "/")) {
      const hit = findByPath(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

/** New tree with `children` grafted onto the dir at `path` (marks it loaded).
 *  Structural sharing everywhere else — safe for React state. */
export function graftChildren(roots: TreeNode[], path: string, children: TreeNode[]): TreeNode[] {
  return roots.map((n) => {
    if (!n.dir) return n;
    if (n.path === path) return { ...n, children, loaded: true };
    if (path.startsWith(n.path + "/")) return { ...n, children: graftChildren(n.children, path, children) };
    return n;
  });
}

export function collectDirPaths(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.dir) {
      out.push(n.path);
      collectDirPaths(n.children, out);
    }
  }
  return out;
}

/** True when every dir in the tree has its children present. */
export function fullyLoaded(roots: TreeNode[]): boolean {
  for (const n of roots) {
    if (n.dir && (!n.loaded || !fullyLoaded(n.children))) return false;
  }
  return true;
}
