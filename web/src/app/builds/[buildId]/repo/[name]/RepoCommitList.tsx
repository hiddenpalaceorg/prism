"use client";

// The global commit log reachable from the current revision, newest-first,
// one compact line per commit — the full history, no pagination (11k rows
// render fine; the server page ships only the first slice for fast paint and
// the rest arrives with one fetch). The parent remounts this per revision
// (key={revOid}). Clicking a commit opens its change set.

import { useEffect, useState } from "react";
import { commitSubject, formatCommitDate, type RepoCommit } from "@/lib/repo-manifest";

// One request for everything; far above any real repo (Fallout is 11,432).
const ALL = 50_000;

export default function RepoCommitList({
  apiBase,
  revOid,
  initial,
  onSelectCommit,
}: {
  apiBase: string;
  revOid: string;
  /** Server-rendered first slice, when this revision was the SSR one. */
  initial: { total: number; commits: RepoCommit[] } | null;
  onSelectCommit: (oid: string) => void;
}) {
  const [commits, setCommits] = useState<RepoCommit[]>(initial?.commits ?? []);
  const [total, setTotal] = useState<number | null>(initial?.total ?? null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/commits?rev=${revOid}&limit=${ALL}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ total: number; commits: RepoCommit[] }>;
      })
      .then(
        (data) => {
          if (!cancelled) {
            setCommits(data.commits);
            setTotal(data.total);
            setError(false);
          }
        },
        () => {
          if (!cancelled) setError(true);
        }
      );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <h2 className="text-sm font-medium">
        History{" "}
        {total !== null && <span className="font-normal text-neutral-400">({total} commits)</span>}
      </h2>
      {error && <p className="mt-3 text-xs text-red-500">Failed to load the full history.</p>}
      <ul className="mt-2 divide-y divide-neutral-100 dark:divide-neutral-900/60">
        {commits.map((c) => (
          <li key={c.oid}>
            <button
              onClick={() => onSelectCommit(c.oid)}
              className="flex w-full items-baseline gap-2 px-1 py-0.5 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-900/40"
              title="Show this commit's changes"
            >
              <span className="shrink-0 font-mono text-neutral-500">{formatCommitDate(c.author)}</span>
              {c.parents.length > 1 && (
                <span className="shrink-0 rounded bg-neutral-100 px-1 text-[10px] uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  merge
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">
                {commitSubject(c.message) || "(no message)"}
                <span className="ml-1 text-neutral-400">{c.author.name}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {total !== null && commits.length < total && (
        <p className="mt-2 text-xs text-neutral-400">Loading {total - commits.length} older commits…</p>
      )}
    </div>
  );
}
