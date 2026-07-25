"use client";

// Per-file history panel: the revisions of the open file, walking first
// parents from the current revision (the log the parent fetched — its head
// entry is the version on screen). Clicking an entry opens that change as a
// side-by-side diff in the main panel.

import { commitSubject, formatCommitDate } from "@/lib/repo-manifest";
import type { LogState } from "./RepoViewer";

// Modifications are the common case and carry no badge; only the lifecycle
// events are called out.
const CHANGE_STYLE: Record<string, string> = {
  add: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  delete: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200",
};

export default function RepoFileHistory({
  path,
  log,
  selectedDiff,
  onSelectDiff,
}: {
  path: string;
  log: LogState;
  /** Short oid of the change open in the diff view, if any. */
  selectedDiff: string | null;
  onSelectDiff: (oid: string) => void;
}) {
  return (
    <div>
      <h2 className="text-sm font-medium">
        File history{" "}
        {Array.isArray(log) && (
          <span className="font-normal text-neutral-400">({log.length})</span>
        )}
      </h2>
      {log === "loading" && <p className="mt-3 text-xs text-neutral-400">Loading…</p>}
      {log === "error" && <p className="mt-3 text-xs text-red-500">Failed to load history.</p>}
      {Array.isArray(log) && log.length === 0 && (
        <p className="mt-3 text-xs text-neutral-500">No history for {path} at this revision.</p>
      )}
      {Array.isArray(log) && log.length > 0 && (
        <ul className="mt-2 divide-y divide-neutral-100 dark:divide-neutral-900/60">
          {log.map((e) => {
            const selected = selectedDiff !== null && e.oid.startsWith(selectedDiff);
            return (
              <li key={e.oid}>
                <button
                  onClick={() => onSelectDiff(e.oid)}
                  className={`flex w-full items-baseline gap-2 px-1 py-1.5 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-900/40 ${
                    selected ? "bg-sky-50 dark:bg-sky-950/40" : ""
                  }`}
                  title="Show this change as a diff"
                >
                  <span className="shrink-0 font-mono text-neutral-500">
                    {formatCommitDate(e.author)}
                  </span>
                  {CHANGE_STYLE[e.change] && (
                    <span
                      className={`shrink-0 rounded px-1 text-[10px] uppercase tracking-wide ${CHANGE_STYLE[e.change]}`}
                    >
                      {e.change}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {commitSubject(e.message) || "(no message)"}
                    <span className="ml-1 text-neutral-400">{e.author.name}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
