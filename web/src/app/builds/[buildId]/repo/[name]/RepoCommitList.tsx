"use client";

// The global commit log reachable from the current revision, newest-first,
// paginated. The parent remounts this per revision (key={revOid}) and passes
// the server-rendered first page for the initial one; later revisions fetch
// their own. Clicking a commit rewinds the whole viewer to that snapshot.

import { useEffect, useState } from "react";
import { commitSubject, formatCommitDate, shortOid, type RepoCommit } from "@/lib/repo-manifest";

const PAGE = 50;

export default function RepoCommitList({
  apiBase,
  revOid,
  initial,
  onSelectCommit,
}: {
  apiBase: string;
  revOid: string;
  initial: { total: number; commits: RepoCommit[] } | null;
  onSelectCommit: (oid: string) => void;
}) {
  const [commits, setCommits] = useState<RepoCommit[]>(initial?.commits ?? []);
  const [total, setTotal] = useState<number | null>(initial?.total ?? null);
  // Callers flip busy on before fetching, so no state is ever set
  // synchronously inside the effect (the initial fetch starts busy).
  const [busy, setBusy] = useState(initial === null);
  const [error, setError] = useState(false);

  const loadPage = (offset: number) =>
    fetch(`${apiBase}/commits?rev=${revOid}&offset=${offset}&limit=${PAGE}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ total: number; commits: RepoCommit[] }>;
      })
      .then(
        (data) => {
          setCommits((prev) => (offset === 0 ? data.commits : [...prev, ...data.commits]));
          setTotal(data.total);
          setError(false);
          setBusy(false);
        },
        () => {
          setError(true);
          setBusy(false);
        }
      );

  // No server-rendered page for this revision — fetch the first one.
  useEffect(() => {
    if (initial === null) void loadPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <h2 className="text-lg font-medium">
        History{" "}
        {total !== null && <span className="text-sm font-normal text-neutral-400">({total} commits)</span>}
      </h2>
      {error && <p className="mt-3 text-sm text-red-500">Failed to load commits — try again.</p>}
      <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-900/60">
        {commits.map((c) => (
          <li key={c.oid}>
            <button
              onClick={() => onSelectCommit(c.oid)}
              className="flex w-full items-baseline gap-3 py-2 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900/40"
              title={`Browse the tree at ${shortOid(c.oid)}`}
            >
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-xs ${
                  c.oid === revOid
                    ? "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {shortOid(c.oid)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{commitSubject(c.message) || "(no message)"}</span>
                <span className="mt-0.5 block text-xs text-neutral-500">
                  {c.author.name} · {formatCommitDate(c.author)}
                  {c.parents.length > 1 && (
                    <span className="ml-2 rounded bg-neutral-100 px-1 uppercase tracking-wide text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                      merge
                    </span>
                  )}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {busy && <p className="mt-3 text-sm text-neutral-400">Loading…</p>}
      {!busy && total !== null && commits.length < total && (
        <button
          onClick={() => {
            setBusy(true);
            void loadPage(commits.length);
          }}
          className="mt-3 text-sm text-neutral-500 hover:underline"
        >
          Load more ({total - commits.length} older)
        </button>
      )}
    </div>
  );
}
