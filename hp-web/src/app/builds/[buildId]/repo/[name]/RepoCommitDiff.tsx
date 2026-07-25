"use client";

// One commit's full change set: every file it touched relative to its first
// parent, each expandable into the same side-by-side line diff as the
// per-file history view. Small commits open fully expanded; bulk commits
// (imports, merges) start as a file list so thousands of blobs aren't
// fetched at once.

import { useEffect, useState } from "react";
import {
  commitSubject,
  formatCommitDate,
  shortOid,
  type RepoIdent,
} from "@/lib/repo-manifest";
import { DiffBody, TEXT_DISPLAY_CAP, useBlobPair } from "./RepoDiffView";

const AUTO_EXPAND_FILES = 10;

const CHANGE_STYLE: Record<string, string> = {
  add: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  delete: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200",
};

interface CommitChangeDto {
  path: string;
  change: "add" | "modify" | "delete";
  from: string | null;
  to: string | null;
  fromSize: number | null;
  toSize: number | null;
  binary: boolean;
}

interface CommitDto {
  oid: string;
  parents: string[];
  author: RepoIdent;
  committer: RepoIdent;
  message: string;
  changes: CommitChangeDto[];
}

function FileDiff({ apiBase, change }: { apiBase: string; change: CommitChangeDto }) {
  const pair = useBlobPair(apiBase, change.from, change.to);
  if (change.binary) return <p className="p-4 text-xs text-neutral-500">Binary change — no diff view.</p>;
  if ((change.fromSize ?? 0) > TEXT_DISPLAY_CAP || (change.toSize ?? 0) > TEXT_DISPLAY_CAP) {
    return <p className="p-4 text-xs text-neutral-500">File too large to diff.</p>;
  }
  if (pair === "loading") return <p className="p-4 text-xs text-neutral-400">Loading…</p>;
  if (pair === "error") return <p className="p-4 text-xs text-red-500">Failed to load file versions.</p>;
  return <DiffBody before={pair.from} after={pair.to} />;
}

export default function RepoCommitDiff({
  apiBase,
  diffOid,
  onBrowse,
  onClose,
}: {
  apiBase: string;
  /** Short (or full) oid of the commit whose changes are shown. */
  diffOid: string;
  /** Rewind the whole viewer (tree + log) to this commit's snapshot. */
  onBrowse: (oid: string) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<{ key: string; value: CommitDto | "loading" | "error" }>({
    key: diffOid,
    value: "loading",
  });
  const [expanded, setExpanded] = useState<Set<string> | null>(null); // null = auto
  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/commit?rev=${encodeURIComponent(diffOid)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<CommitDto>;
      })
      .then(
        (data) => {
          if (!cancelled) setState({ key: diffOid, value: data });
        },
        () => {
          if (!cancelled) setState({ key: diffOid, value: "error" });
        }
      );
    return () => {
      cancelled = true;
    };
  }, [apiBase, diffOid]);

  const commit = state.key === diffOid ? state.value : "loading";
  if (commit === "loading") return <p className="p-6 text-sm text-neutral-400">Loading…</p>;
  if (commit === "error") {
    return (
      <div className="rounded border border-neutral-200 p-6 text-sm text-neutral-500 dark:border-neutral-800">
        No such commit.{" "}
        <button onClick={onClose} className="text-sky-700 hover:underline dark:text-sky-400">
          Back to history
        </button>
      </div>
    );
  }

  const open = expanded ?? new Set(commit.changes.length <= AUTO_EXPAND_FILES ? commit.changes.map((c) => c.path) : []);
  const toggle = (path: string) =>
    setExpanded(() => {
      const next = new Set(open);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div>
      <div className="rounded border border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center gap-3 px-4 py-2 text-sm">
          <span className="min-w-0 flex-1">
            <span className="font-medium">{commitSubject(commit.message) || "(no message)"}</span>
            <span className="ml-2 text-xs text-neutral-500">
              {commit.author.name} · {formatCommitDate(commit.author)}
              {commit.parents.length > 1 && (
                <span className="ml-2 rounded bg-neutral-100 px-1 uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  merge
                </span>
              )}
            </span>
          </span>
          <button
            onClick={() => onBrowse(commit.oid)}
            className="shrink-0 text-xs text-neutral-500 hover:underline"
            title={`Browse the tree at ${shortOid(commit.oid)}`}
          >
            browse tree
          </button>
          <button
            onClick={onClose}
            aria-label="Back to history"
            className="shrink-0 rounded px-2 py-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            &times;
          </button>
        </div>
        {commit.message.includes("\n") && commit.message.split("\n").slice(1).join("\n").trim() && (
          <pre className="whitespace-pre-wrap break-words border-t border-neutral-100 px-4 py-2 font-mono text-xs text-neutral-500 dark:border-neutral-900">
            {commit.message.split("\n").slice(1).join("\n").trim()}
          </pre>
        )}
      </div>

      <p className="mt-3 text-xs text-neutral-500">
        {commit.changes.length} file{commit.changes.length === 1 ? "" : "s"} changed
      </p>

      <div className="mt-2 flex flex-col gap-3">
        {commit.changes.map((c) => (
          <div key={c.path} className="rounded border border-neutral-200 dark:border-neutral-800">
            {/* Sticks to the top of the scrolling main column while its diff scrolls by. */}
            <button
              onClick={() => toggle(c.path)}
              className="sticky top-0 z-10 flex w-full items-center gap-2 rounded-t border-b border-neutral-100 bg-neutral-50 px-3 py-1.5 text-left text-xs dark:border-neutral-900 dark:bg-neutral-900"
            >
              <span className="w-3 shrink-0 text-[10px] text-neutral-400">{open.has(c.path) ? "▾" : "▸"}</span>
              <span className="min-w-0 flex-1 truncate font-mono">{c.path}</span>
              {CHANGE_STYLE[c.change] && (
                <span className={`shrink-0 rounded px-1 text-[10px] uppercase tracking-wide ${CHANGE_STYLE[c.change]}`}>
                  {c.change}
                </span>
              )}
            </button>
            {open.has(c.path) && <FileDiff apiBase={apiBase} change={c} />}
          </div>
        ))}
      </div>
    </div>
  );
}
