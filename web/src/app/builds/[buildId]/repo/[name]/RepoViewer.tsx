"use client";

// State owner of the repo viewer: a file tree at a revision, a main panel
// showing either the commit log or one file, and a per-file history panel.
// ?rev= and ?path= mirror the state — every view is deep-linkable, and
// back/forward replay navigation. pushState/replaceState are shallow (Next
// keeps the page mounted), the AssetViewerHost pattern adapted to query
// params. Data comes from /api/repo/<manifest sha>/... whose responses are
// immutable per URL, so the browser cache makes revisits free.

import { useCallback, useEffect, useRef, useState } from "react";
import { initialExpanded, type TreeNode } from "@/lib/filetree";
import { shortOid, type RepoCommit, type RepoLogEntryDto } from "@/lib/repo-manifest";
import RepoCommitList from "./RepoCommitList";
import RepoFileHistory from "./RepoFileHistory";
import RepoFileTree from "./RepoFileTree";
import RepoFileView from "./RepoFileView";

interface View {
  /** The ?rev= form: "" (HEAD), a ref name, or an oid prefix. */
  rev: string;
  path: string | null;
}

export type LogState = RepoLogEntryDto[] | "loading" | "error";

export default function RepoViewer({
  apiBase,
  repoHref,
  head,
  headRef,
  refs,
  initialRev,
  initialRevOid,
  initialPath,
  initialRoots,
  initialExpandedPaths,
  initialTotal,
  initialCommits,
  initialLog,
}: {
  apiBase: string;
  repoHref: string;
  head: string;
  headRef: string | null;
  refs: { name: string; oid: string }[];
  initialRev: string;
  initialRevOid: string;
  initialPath: string | null;
  initialRoots: TreeNode[];
  initialExpandedPaths: string[];
  initialTotal: number;
  initialCommits: RepoCommit[];
  initialLog: RepoLogEntryDto[] | null;
}) {
  const [view, setView] = useState<View>({ rev: initialRev, path: initialPath });
  // The resolved commit oid of view.rev. Known instantly when navigation
  // originates from a commit row or the ref selector; a deep-linked prefix
  // resolves through the tree fetch's `rev` echo.
  const [revOid, setRevOid] = useState(initialRevOid);
  const [tree, setTree] = useState({ roots: initialRoots, expanded: initialExpandedPaths });
  const [treeError, setTreeError] = useState(false);
  const [log, setLog] = useState<LogState>(initialLog ?? "loading");

  const navigate = useCallback(
    (next: View, oid?: string) => {
      const qs = new URLSearchParams();
      if (next.rev) qs.set("rev", next.rev);
      if (next.path) qs.set("path", next.path);
      window.history.pushState(null, "", `${repoHref}${qs.size ? `?${qs}` : ""}`);
      if (oid) setRevOid(oid);
      setView(next);
    },
    [repoHref]
  );

  // Back/forward: re-derive the view from wherever the URL landed.
  useEffect(() => {
    const onPop = () => {
      const qs = new URLSearchParams(window.location.search);
      setView({ rev: qs.get("rev") ?? "", path: qs.get("path") });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Revision changed: fetch that snapshot's full tree (which also resolves a
  // prefix/ref rev to its oid). The server-rendered rev is already loaded.
  const loadedTree = useRef(initialRev);
  useEffect(() => {
    if (view.rev === loadedTree.current) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/tree?rev=${encodeURIComponent(view.rev)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: { rev: string; roots: TreeNode[] } = await res.json();
        if (cancelled) return;
        loadedTree.current = view.rev;
        setRevOid(data.rev);
        setTree({ roots: data.roots, expanded: [...initialExpanded(data.roots)] });
        setTreeError(false);
      } catch {
        if (!cancelled) setTreeError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view.rev, apiBase]);

  // File (or revision under it) changed: fetch its history. The head entry is
  // the file's version at this rev, so this one fetch also drives the viewer.
  const loadedLog = useRef(initialPath ? `${initialRevOid}\0${initialPath}` : "");
  useEffect(() => {
    const path = view.path;
    if (!path) return;
    const key = `${revOid}\0${path}`;
    if (key === loadedLog.current) return;
    let cancelled = false;
    setLog("loading");
    (async () => {
      try {
        const res = await fetch(`${apiBase}/log?rev=${revOid}&path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: { entries: RepoLogEntryDto[] } = await res.json();
        if (cancelled) return;
        loadedLog.current = key;
        setLog(data.entries);
      } catch {
        if (!cancelled) setLog("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view.path, revOid, apiBase]);

  const openFile = useCallback((path: string) => navigate({ rev: view.rev, path }), [navigate, view.rev]);
  const closeFile = useCallback(() => navigate({ rev: view.rev, path: null }), [navigate, view.rev]);
  const selectCommit = useCallback(
    (oid: string) => navigate({ rev: shortOid(oid), path: view.path }, oid),
    [navigate, view.path]
  );
  const selectRef = useCallback(
    (name: string) => {
      const oid = name === "" ? head : refs.find((r) => r.name === name)?.oid;
      navigate({ rev: name, path: view.path }, oid);
    },
    [navigate, view.path, head, refs]
  );

  return (
    <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-start">
      <aside className="w-full shrink-0 lg:w-80 xl:w-96">
        <div className="flex items-center gap-2">
          <RevSelector refs={refs} headRef={headRef} value={view.rev} revOid={revOid} onSelect={selectRef} />
          {view.path !== null && (
            <button onClick={closeFile} className="text-xs text-neutral-500 hover:underline">
              commit log
            </button>
          )}
        </div>
        {treeError && <p className="mt-2 text-xs text-red-500">Failed to load this revision.</p>}
        <div className="mt-3 max-h-[75vh] overflow-auto rounded border border-neutral-200 dark:border-neutral-800">
          <RepoFileTree
            key={revOid}
            apiBase={apiBase}
            revOid={revOid}
            roots={tree.roots}
            initiallyExpanded={tree.expanded}
            selectedPath={view.path}
            onOpenFile={openFile}
          />
        </div>
      </aside>

      <section className="min-w-0 flex-1">
        {view.path !== null ? (
          <RepoFileView apiBase={apiBase} path={view.path} log={log} />
        ) : (
          <RepoCommitList
            key={revOid}
            apiBase={apiBase}
            revOid={revOid}
            initial={revOid === initialRevOid ? { total: initialTotal, commits: initialCommits } : null}
            onSelectCommit={selectCommit}
          />
        )}
      </section>

      {view.path !== null && (
        <aside className="w-full shrink-0 xl:w-96">
          <RepoFileHistory path={view.path} log={log} revOid={revOid} onSelectCommit={selectCommit} />
        </aside>
      )}
    </div>
  );
}

// A plain select over the manifest's frozen refs; an arbitrary oid rev shows
// as a synthetic (disabled-change) entry so the control always reflects state.
function RevSelector({
  refs,
  headRef,
  value,
  revOid,
  onSelect,
}: {
  refs: { name: string; oid: string }[];
  headRef: string | null;
  value: string;
  revOid: string;
  onSelect: (name: string) => void;
}) {
  const OID = "\0oid";
  const isNamed = value === "" || refs.some((r) => r.name === value);
  return (
    <select
      value={isNamed ? value : OID}
      onChange={(e) => {
        if (e.target.value !== OID) onSelect(e.target.value);
      }}
      className="rounded border border-neutral-200 bg-white px-2 py-1 font-mono text-xs dark:border-neutral-800 dark:bg-neutral-950"
      aria-label="Revision"
    >
      <option value="">{headRef ? `${headRef} (HEAD)` : "HEAD"}</option>
      {refs
        .filter((r) => r.name !== headRef)
        .map((r) => (
          <option key={r.name} value={r.name}>
            {r.name}
          </option>
        ))}
      {!isNamed && <option value={OID}>{shortOid(revOid)}</option>}
    </select>
  );
}
