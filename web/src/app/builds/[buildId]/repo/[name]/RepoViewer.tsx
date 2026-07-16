"use client";

// State owner of the repo viewer: a file tree at a revision, a main panel
// showing the commit log, one file, or one change's side-by-side diff, and a
// per-file history panel. ?rev=, ?path= and ?diff= mirror the state — every
// view is deep-linkable, and back/forward replay navigation. pushState /
// replaceState are shallow (Next keeps the page mounted), the AssetViewerHost
// pattern adapted to query params. Data comes from /api/repo/<manifest sha>/
// whose responses are immutable per URL, so the browser cache makes revisits
// free.
//
// Layout is a grid with fixed column widths and a fixed-height tree panel —
// regions never resize with their content, so opening files or loading data
// doesn't shift the page.

import { useCallback, useEffect, useRef, useState } from "react";
import { initialExpanded, type TreeNode } from "@/lib/filetree";
import { shortOid, type RepoCommit, type RepoLogEntryDto } from "@/lib/repo-manifest";
import RepoCommitDiff from "./RepoCommitDiff";
import RepoCommitList from "./RepoCommitList";
import RepoDiffView from "./RepoDiffView";
import RepoFileHistory from "./RepoFileHistory";
import RepoFileTree from "./RepoFileTree";
import RepoFileView from "./RepoFileView";

interface View {
  /** The ?rev= form: "" (HEAD), a ref name, or an oid prefix. */
  rev: string;
  path: string | null;
  /** Short oid of the file-history change open as a diff. */
  diff: string | null;
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
  initialDiff,
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
  initialDiff: string | null;
  initialRoots: TreeNode[];
  initialExpandedPaths: string[];
  initialTotal: number;
  initialCommits: RepoCommit[];
  initialLog: RepoLogEntryDto[] | null;
}) {
  const [view, setView] = useState<View>({ rev: initialRev, path: initialPath, diff: initialDiff });
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
      if (next.diff) qs.set("diff", next.diff);
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
      setView({ rev: qs.get("rev") ?? "", path: qs.get("path"), diff: qs.get("diff") });
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

  const openFile = useCallback(
    (path: string) => navigate({ rev: view.rev, path, diff: null }),
    [navigate, view.rev]
  );
  const closeFile = useCallback(
    () => navigate({ rev: view.rev, path: null, diff: null }),
    [navigate, view.rev]
  );
  // A commit row opens that commit's change set; "browse tree" inside the
  // overview is what rewinds the whole viewer to the snapshot.
  const selectCommit = useCallback(
    (oid: string) => navigate({ rev: view.rev, path: null, diff: shortOid(oid) }),
    [navigate, view.rev]
  );
  const browseCommit = useCallback(
    (oid: string) => navigate({ rev: shortOid(oid), path: null, diff: null }, oid),
    [navigate]
  );
  const selectRef = useCallback(
    (name: string) => {
      const oid = name === "" ? head : refs.find((r) => r.name === name)?.oid;
      navigate({ rev: name, path: view.path, diff: null }, oid);
    },
    [navigate, view.path, head, refs]
  );
  const selectDiff = useCallback(
    (oid: string) => navigate({ rev: view.rev, path: view.path, diff: shortOid(oid) }),
    [navigate, view.rev, view.path]
  );
  const closeDiff = useCallback(
    () => navigate({ rev: view.rev, path: view.path, diff: null }),
    [navigate, view.rev, view.path]
  );

  return (
    // Fixed-width columns filling the rest of the viewport at lg+ (the page
    // wrapper is h-dvh overflow-hidden); every panel scrolls internally with
    // a stable scrollbar gutter, so nothing shifts as content loads or the
    // view changes. Below lg the panels stack and the page scrolls.
    <div className="mt-4 grid min-h-0 items-stretch gap-x-6 gap-y-4 lg:flex-1 lg:grid-cols-[15rem_minmax(0,1fr)_18rem] xl:grid-cols-[16rem_minmax(0,1fr)_22rem]">
      <aside className="flex min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2">
          <RevSelector refs={refs} headRef={headRef} value={view.rev} revOid={revOid} onSelect={selectRef} />
          {view.path !== null && (
            <button onClick={closeFile} className="text-xs text-neutral-500 hover:underline">
              commit log
            </button>
          )}
        </div>
        {treeError && <p className="mt-2 shrink-0 text-xs text-red-500">Failed to load this revision.</p>}
        <div className="mt-3 h-[60vh] overflow-auto rounded border border-neutral-200 [scrollbar-gutter:stable] dark:border-neutral-800 lg:h-auto lg:flex-1 lg:min-h-0">
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

      <section className="min-w-0 lg:min-h-0 lg:overflow-auto lg:[scrollbar-gutter:stable]">
        {view.path !== null ? (
          view.diff !== null ? (
            <RepoDiffView apiBase={apiBase} path={view.path} log={log} diffOid={view.diff} onClose={closeDiff} />
          ) : (
            <RepoFileView apiBase={apiBase} path={view.path} log={log} />
          )
        ) : view.diff !== null ? (
          <RepoCommitDiff apiBase={apiBase} diffOid={view.diff} onBrowse={browseCommit} onClose={closeDiff} />
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

      {/* Always present so the main panel's width never changes with the view. */}
      <aside className="lg:min-h-0 lg:overflow-auto lg:[scrollbar-gutter:stable]">
        {view.path !== null && (
          <RepoFileHistory path={view.path} log={log} selectedDiff={view.diff} onSelectDiff={selectDiff} />
        )}
      </aside>
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
