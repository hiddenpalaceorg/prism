"use client";

// Side-by-side diff of one file-history entry: the file after that commit
// (right, green) against the version it replaced (left, red) — the previous
// entry in the already-fetched log, since between entries the blob is
// unchanged along the first-parent chain. Both versions come from the blob
// route; the line pairing lives in lib/linediff. Long unchanged stretches
// collapse to expandable bars.

import { Fragment, useEffect, useMemo, useState } from "react";
import { diffRows, visibleSpans, type DiffRow } from "@/lib/linediff";
import { commitSubject, formatCommitDate, type RepoLogEntryDto } from "@/lib/repo-manifest";
import type { LogState } from "./RepoViewer";

// Same cap as the file view: don't diff what we wouldn't display.
export const TEXT_DISPLAY_CAP = 1_000_000;

export type Fetched = { from: string; to: string } | "loading" | "error";

/** Both versions of a file, fetched from the blob route (null oid = empty
 *  side). Shared with the commit overview's per-file diffs. */
export function useBlobPair(apiBase: string, fromOid: string | null, toOid: string | null): Fetched {
  // Results are stored with the pair they belong to; a stale pair reads as
  // "loading" so the effect never has to reset state synchronously.
  const key = `${fromOid}\0${toOid}`;
  const [state, setState] = useState<{ key: string; value: Fetched }>({ key, value: "loading" });
  useEffect(() => {
    let cancelled = false;
    const get = async (oid: string | null): Promise<string> => {
      if (!oid) return "";
      const res = await fetch(`${apiBase}/blob/${oid}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      return new TextDecoder().decode(buf.slice(0, TEXT_DISPLAY_CAP));
    };
    Promise.all([get(fromOid), get(toOid)]).then(
      ([from, to]) => {
        if (!cancelled) setState({ key, value: { from, to } });
      },
      () => {
        if (!cancelled) setState({ key, value: "error" });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [apiBase, fromOid, toOid, key]);
  return state.key === key ? state.value : "loading";
}

function Cell({ cell, changed, side }: { cell: DiffRow["l"]; changed: boolean; side: "l" | "r" }) {
  const bg = !changed
    ? ""
    : cell === null
      ? "bg-neutral-50 dark:bg-neutral-900/40"
      : side === "l"
        ? "bg-red-50 dark:bg-red-950/40"
        : "bg-emerald-50 dark:bg-emerald-950/40";
  return (
    <>
      <span className={`select-none px-2 text-right text-neutral-400 ${bg}`}>{cell?.n ?? ""}</span>
      <span className={`whitespace-pre-wrap break-words px-2 ${bg}`}>{cell?.s ?? ""}</span>
    </>
  );
}

export function DiffBody({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => diffRows(before, after), [before, after]);
  const spans = useMemo(() => visibleSpans(rows), [rows]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  if (spans.length === 0) {
    return <p className="p-6 text-xs text-neutral-500">No line changes.</p>;
  }

  // Interleave visible spans with collapsible gaps (before, between, after).
  const segments: Array<{ gap: boolean; from: number; to: number }> = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start > cursor) segments.push({ gap: true, from: cursor, to: start });
    segments.push({ gap: false, from: start, to: end });
    cursor = end;
  }
  if (cursor < rows.length) segments.push({ gap: true, from: cursor, to: rows.length });

  return (
    <div className="p-3 font-mono text-xs leading-5 text-neutral-800 dark:text-neutral-200">
      <div className="grid grid-cols-[3rem_minmax(0,1fr)_3rem_minmax(0,1fr)]">
        {segments.map((seg) =>
          seg.gap && !expanded.has(seg.from) ? (
            <button
              key={`gap-${seg.from}`}
              onClick={() => setExpanded((prev) => new Set(prev).add(seg.from))}
              className="col-span-4 border-y border-neutral-100 bg-neutral-50 py-0.5 text-center text-[10px] text-neutral-400 hover:text-neutral-600 dark:border-neutral-900 dark:bg-neutral-900/40 dark:hover:text-neutral-300"
            >
              {seg.to - seg.from} unchanged lines
            </button>
          ) : (
            <Fragment key={`rows-${seg.from}`}>
              {rows.slice(seg.from, seg.to).map((row, i) => (
                <Fragment key={seg.from + i}>
                  <Cell cell={row.l} changed={row.changed} side="l" />
                  <Cell cell={row.r} changed={row.changed} side="r" />
                </Fragment>
              ))}
            </Fragment>
          )
        )}
      </div>
    </div>
  );
}

export default function RepoDiffView({
  apiBase,
  path,
  log,
  diffOid,
  onClose,
}: {
  apiBase: string;
  path: string;
  log: LogState;
  /** Short (or full) oid of the commit whose change is being viewed. */
  diffOid: string;
  onClose: () => void;
}) {
  const entries = Array.isArray(log) ? log : null;
  const index = entries ? entries.findIndex((e) => e.oid.startsWith(diffOid)) : -1;
  const entry: RepoLogEntryDto | null = index >= 0 ? entries![index] : null;
  const before = index >= 0 ? (entries![index + 1] ?? null) : null;

  // Hooks before any early return; oids are null until the log resolves.
  const pair = useBlobPair(apiBase, before?.blob ?? null, entry?.blob ?? null);

  if (log === "loading") return <p className="p-6 text-sm text-neutral-400">Loading…</p>;
  if (log === "error") return <p className="p-6 text-sm text-red-500">Failed to load file history.</p>;

  const name = path.split("/").pop() || path;
  const header = (children: React.ReactNode) => (
    <div className="rounded border border-neutral-200 dark:border-neutral-800">
      {/* Sticks to the top of the scrolling main column. */}
      <div className="sticky top-0 z-10 flex items-center gap-3 rounded-t border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        <span className="min-w-0 flex-1 truncate">
          <span className="font-mono">{name}</span>
          {entry && (
            <span className="ml-2 text-xs text-neutral-500">
              {formatCommitDate(entry.author)} · {commitSubject(entry.message) || "(no message)"}
            </span>
          )}
        </span>
        <button
          onClick={onClose}
          aria-label="Close diff"
          className="shrink-0 rounded px-2 py-0.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          &times;
        </button>
      </div>
      {children}
    </div>
  );

  if (!entry) {
    return header(<p className="p-6 text-sm text-neutral-500">No such change in this file&apos;s history.</p>);
  }
  if (entry.binary || before?.binary) {
    return header(<p className="p-6 text-sm text-neutral-500">Binary change — no diff view.</p>);
  }
  if ((entry.size ?? 0) > TEXT_DISPLAY_CAP || (before?.size ?? 0) > TEXT_DISPLAY_CAP) {
    return header(<p className="p-6 text-sm text-neutral-500">File too large to diff.</p>);
  }
  if (pair === "loading") return header(<p className="p-6 text-sm text-neutral-400">Loading…</p>);
  if (pair === "error") return header(<p className="p-6 text-sm text-red-500">Failed to load file versions.</p>);

  return header(<DiffBody before={pair.from} after={pair.to} />);
}
