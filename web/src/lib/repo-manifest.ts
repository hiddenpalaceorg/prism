// Attached source repository manifests (VSS->git conversions). A repo is
// converted offline by scripts/attach-repo.ts into (a) one asset-store blob
// per unique git blob and (b) one manifest blob described by these types —
// commits, deduplicated tree objects, and a git-blob-oid -> store-sha256 map.
// The web app answers every tree/log/file query from the manifest alone, so
// serving needs no git implementation at all. Pure data + walks — no DB, no
// React, no I/O — shared by the attach script, the server loader (repo.ts),
// the API routes, and the client components.

import type { Node } from "./types";

export const REPO_MANIFEST_VERSION = 1;

/** Repo names become URL segments; the attach script enforces this. */
export const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Git identity. time = epoch seconds; tz = minutes from UTC in the
 *  JS getTimezoneOffset convention (UTC+2 -> -120), as isomorphic-git emits. */
export interface RepoIdent {
  name: string;
  email: string;
  time: number;
  tz: number;
}

export interface RepoCommit {
  oid: string; // full 40-hex
  tree: string; // root tree oid
  parents: string[]; // parents[0] = first parent
  author: RepoIdent;
  committer: RepoIdent;
  message: string; // full message (capped at attach time)
}

/** [entry name, type, oid]. Gitlinks (submodules) are dropped at attach time;
 *  symlinks ride along as blobs (their content is the target path). */
export type RepoTreeEntry = [name: string, type: "blob" | "tree", oid: string];

/** [store sha256, byte size, 1 if binary else 0]. */
export type RepoBlobInfo = [sha256: string, size: number, binary: 0 | 1];

export interface RepoManifest {
  version: number;
  name: string;
  /** Commit HEAD pointed at when the repo was attached. */
  head: string;
  /** Symbolic HEAD name ("master"), null when detached. */
  headRef: string | null;
  /** Branches then tags, name-sorted; only refs whose commits were walked. */
  refs: { name: string; oid: string }[];
  /** Newest-first: committer.time desc, tie-broken by oid. */
  commits: RepoCommit[];
  trees: Record<string, RepoTreeEntry[]>;
  blobs: Record<string, RepoBlobInfo>;
}

/** A manifest with lookup maps built once — what everything downstream takes. */
export interface RepoIndex {
  manifest: RepoManifest;
  commitByOid: Map<string, RepoCommit>;
  trees: Map<string, RepoTreeEntry[]>;
  blobs: Map<string, RepoBlobInfo>;
  refByName: Map<string, string>;
  /** Sorted commit oids, for unique-prefix resolution. */
  oids: string[];
}

export function indexManifest(m: RepoManifest): RepoIndex {
  return {
    manifest: m,
    commitByOid: new Map(m.commits.map((c) => [c.oid, c])),
    trees: new Map(Object.entries(m.trees)),
    blobs: new Map(Object.entries(m.blobs)),
    refByName: new Map(m.refs.map((r) => [r.name, r.oid])),
    oids: m.commits.map((c) => c.oid).sort(),
  };
}

export function shortOid(oid: string): string {
  return oid.slice(0, 10);
}

/** Resolve "HEAD", a ref name, or a 4-40 char unique oid prefix to a commit
 *  oid known to the manifest; null when it doesn't resolve. Refs win over
 *  hex-looking names (a branch called "cafe" beats the oid prefix). */
export function resolveRev(idx: RepoIndex, rev: string): string | null {
  if (rev === "" || rev === "HEAD") return idx.manifest.head;
  const ref = idx.refByName.get(rev);
  if (ref !== undefined) return idx.commitByOid.has(ref) ? ref : null;
  if (!/^[0-9a-f]{4,40}$/.test(rev)) return null;
  if (rev.length === 40) return idx.commitByOid.has(rev) ? rev : null;
  const hits = idx.oids.filter((o) => o.startsWith(rev));
  return hits.length === 1 ? hits[0] : null; // ambiguous or unknown
}

/** The tree entry at `path` in a commit's snapshot, or null when absent.
 *  Paths are "/"-separated, no leading slash. */
export function entryAt(
  idx: RepoIndex,
  commitOid: string,
  path: string
): { type: "blob" | "tree"; oid: string } | null {
  const commit = idx.commitByOid.get(commitOid);
  if (!commit) return null;
  let cur: { type: "blob" | "tree"; oid: string } = { type: "tree", oid: commit.tree };
  for (const seg of path.split("/").filter(Boolean)) {
    if (cur.type !== "tree") return null;
    const entries = idx.trees.get(cur.oid);
    const hit = entries?.find(([name]) => name === seg);
    if (!hit) return null;
    cur = { type: hit[1], oid: hit[2] };
  }
  return cur;
}

/** A commit's whole snapshot as the record-contents Node shape, so the
 *  existing filetree helpers (buildTree, stubChildren, ...) apply unchanged.
 *  Git trees carry no dates, so nodes have none. */
export function treeNodesAt(idx: RepoIndex, commitOid: string): Node[] {
  const commit = idx.commitByOid.get(commitOid);
  if (!commit) return [];
  const walk = (treeOid: string): Node[] =>
    (idx.trees.get(treeOid) ?? []).map(([name, type, oid]) =>
      type === "tree"
        ? { type: "dir", name, children: walk(oid) }
        : { type: "file", name, size: idx.blobs.get(oid)?.[1] }
    );
  return walk(commit.tree);
}

/** Every commit reachable from `fromOid` (all parents — merges included). */
export function ancestorSet(idx: RepoIndex, fromOid: string): Set<string> {
  const seen = new Set<string>();
  const stack = [fromOid];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const c = idx.commitByOid.get(oid);
    if (!c) continue;
    seen.add(oid);
    stack.push(...c.parents);
  }
  return seen;
}

/** One page of the log reachable from `fromOid`, newest-first (the manifest
 *  order filtered to the reachable subgraph — an old rev or side ref shows
 *  exactly its own history). */
export function commitsPage(
  idx: RepoIndex,
  fromOid: string,
  offset: number,
  limit: number
): { total: number; commits: RepoCommit[] } {
  const reachable = ancestorSet(idx, fromOid);
  const all = idx.manifest.commits.filter((c) => reachable.has(c.oid));
  return { total: all.length, commits: all.slice(offset, offset + limit) };
}

export interface FileLogEntry {
  oid: string; // the commit
  change: "add" | "modify" | "delete";
  /** The path's blob oid as of this commit (null for a delete). */
  blob: string | null;
}

/** The revisions of `path`, walking first parents from `fromOid` — the
 *  `git log --first-parent -- path` story: a change merged in from a side
 *  branch is attributed to the merge commit. Emits a commit whenever the
 *  path's entry oid differs from the first parent's; a root commit yields
 *  "add" for every present path. */
export function fileLog(idx: RepoIndex, fromOid: string, path: string, limit = 1000): FileLogEntry[] {
  const out: FileLogEntry[] = [];
  let cur = idx.commitByOid.get(fromOid);
  while (cur && out.length < limit) {
    const parent = cur.parents.length ? idx.commitByOid.get(cur.parents[0]) : undefined;
    const curEntry = entryAt(idx, cur.oid, path);
    const prevEntry = parent ? entryAt(idx, parent.oid, path) : null;
    if ((curEntry?.oid ?? null) !== (prevEntry?.oid ?? null)) {
      out.push({
        oid: cur.oid,
        change: curEntry === null ? "delete" : prevEntry === null ? "add" : "modify",
        blob: curEntry?.oid ?? null,
      });
    }
    cur = parent;
  }
  return out;
}

/** One file changed by a commit (vs its first parent). */
export interface TreeChange {
  path: string;
  change: "add" | "modify" | "delete";
  from: string | null; // blob oid before
  to: string | null; // blob oid after
}

function diffTrees(
  idx: RepoIndex,
  fromOid: string | null,
  toOid: string | null,
  prefix: string,
  out: TreeChange[]
): void {
  if (fromOid === toOid) return; // identical subtree — skip wholesale
  const a = fromOid ? (idx.trees.get(fromOid) ?? []) : [];
  const b = toOid ? (idx.trees.get(toOid) ?? []) : [];
  const bByName = new Map(b.map((e) => [e[0], e]));
  const aNames = new Set(a.map((e) => e[0]));
  for (const [name, type, oid] of a) {
    const path = prefix + name;
    const other = bByName.get(name);
    if (!other) {
      if (type === "blob") out.push({ path, change: "delete", from: oid, to: null });
      else diffTrees(idx, oid, null, path + "/", out);
    } else {
      const [, btype, boid] = other;
      if (type === "blob" && btype === "blob") {
        if (oid !== boid) out.push({ path, change: "modify", from: oid, to: boid });
      } else if (type === "tree" && btype === "tree") {
        diffTrees(idx, oid, boid, path + "/", out);
      } else if (type === "blob") {
        // blob replaced by a directory of the same name
        out.push({ path, change: "delete", from: oid, to: null });
        diffTrees(idx, null, boid, path + "/", out);
      } else {
        // directory replaced by a blob
        diffTrees(idx, oid, null, path + "/", out);
        out.push({ path, change: "add", from: null, to: boid });
      }
    }
  }
  for (const [name, btype, boid] of b) {
    if (aNames.has(name)) continue;
    const path = prefix + name;
    if (btype === "blob") out.push({ path, change: "add", from: null, to: boid });
    else diffTrees(idx, null, boid, path + "/", out);
  }
}

/** Every file a commit changed relative to its first parent (a root commit
 *  adds everything). Merge commits compare against the first parent, matching
 *  fileLog's attribution. Path-sorted. */
export function commitChanges(idx: RepoIndex, commitOid: string): TreeChange[] {
  const commit = idx.commitByOid.get(commitOid);
  if (!commit) return [];
  const parent = commit.parents.length ? idx.commitByOid.get(commit.parents[0]) : undefined;
  const out: TreeChange[] = [];
  diffTrees(idx, parent?.tree ?? null, commit.tree, "", out);
  return out.sort((x, y) => (x.path < y.path ? -1 : 1));
}

/** What /api/repo/.../log serves per entry: a FileLogEntry joined with its
 *  commit's identity/message and its blob's size/binary flag. The first entry
 *  is the path's version at the queried rev (or its deletion). */
export interface RepoLogEntryDto extends FileLogEntry {
  size: number | null;
  binary: boolean;
  author: RepoIdent;
  committer: RepoIdent;
  message: string;
}

/** "YYYY-MM-DD HH:MM" in the identity's own timezone (git log's convention). */
export function formatCommitDate(ident: RepoIdent): string {
  const local = new Date((ident.time - ident.tz * 60) * 1000);
  return local.toISOString().slice(0, 16).replace("T", " ");
}

/** First line of a commit message. */
export function commitSubject(message: string): string {
  const nl = message.indexOf("\n");
  return (nl === -1 ? message : message.slice(0, nl)).trim();
}
