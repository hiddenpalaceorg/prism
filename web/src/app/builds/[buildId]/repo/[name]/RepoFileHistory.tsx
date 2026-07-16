"use client";

// Per-file history panel: the revisions of the open file, walking first
// parents from the current revision (the log the parent fetched — its head
// entry is the version on screen). Clicking an entry rewinds the viewer to
// that commit, so the file shows as of that revision.

import { commitSubject, formatCommitDate, shortOid } from "@/lib/repo-manifest";
import type { LogState } from "./RepoViewer";

const CHANGE_STYLE: Record<string, string> = {
  add: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  modify: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  delete: "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200",
};

export default function RepoFileHistory({
  path,
  log,
  revOid,
  onSelectCommit,
}: {
  path: string;
  log: LogState;
  revOid: string;
  onSelectCommit: (oid: string) => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-medium">
        File history{" "}
        {Array.isArray(log) && (
          <span className="text-sm font-normal text-neutral-400">({log.length})</span>
        )}
      </h2>
      {log === "loading" && <p className="mt-3 text-sm text-neutral-400">Loading…</p>}
      {log === "error" && <p className="mt-3 text-sm text-red-500">Failed to load history.</p>}
      {Array.isArray(log) && log.length === 0 && (
        <p className="mt-3 text-sm text-neutral-500">No history for {path} at this revision.</p>
      )}
      {Array.isArray(log) && log.length > 0 && (
        <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-900/60">
          {log.map((e, i) => (
            <li key={e.oid}>
              <button
                onClick={() => onSelectCommit(e.oid)}
                className={`flex w-full items-baseline gap-2 py-2 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900/40 ${
                  i === 0 ? "" : "opacity-90"
                }`}
                title={`View the file as of ${shortOid(e.oid)}`}
              >
                <span
                  className={`w-14 shrink-0 rounded px-1 text-center text-[10px] uppercase tracking-wide ${CHANGE_STYLE[e.change]}`}
                >
                  {e.change}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{commitSubject(e.message) || "(no message)"}</span>
                  <span className="mt-0.5 block font-mono text-xs text-neutral-500">
                    {e.oid === revOid ? (
                      <span className="mr-1 rounded bg-sky-100 px-1 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200">
                        {shortOid(e.oid)}
                      </span>
                    ) : (
                      <span className="mr-1">{shortOid(e.oid)}</span>
                    )}
                    {e.author.name} · {formatCommitDate(e.author)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
