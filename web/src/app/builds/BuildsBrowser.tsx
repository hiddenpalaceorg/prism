"use client";

import { useDeferredValue, useMemo, useState } from "react";
import RowLink from "./RowLink";
import type { BuildListItem } from "@/lib/queries";

const DISPLAY_CAP = 500;

function humanSize(bytes?: number): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
}

function formatDate(date: string | null): string {
  if (!date) return "—";
  // Stored as "YYYY-MM-DD HH:MM:SS" — show just the day.
  const m = date.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : date;
}

type SortKey = "name" | "system" | "build_date" | "file_count" | "total_size";

export default function BuildsBrowser({ builds }: { builds: BuildListItem[] }) {
  const [query, setQuery] = useState("");
  const [system, setSystem] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  // Defer the query the filter reads so typing stays responsive on large lists.
  const deferredQuery = useDeferredValue(query);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }));

  const systems = useMemo(
    () => Array.from(new Set(builds.map((b) => b.system))).sort((a, b) => a.localeCompare(b)),
    [builds]
  );

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return builds.filter(
      (b) => (!system || b.system === system) && (!q || b.name.toLowerCase().includes(q))
    );
  }, [builds, deferredQuery, system]);

  const sorted = useMemo(() => {
    const { key, dir } = sort;
    return [...filtered].sort((a, b) => {
      if (key === "file_count" || key === "total_size") return (a[key] - b[key]) * dir;
      if (key === "build_date") {
        // Missing dates always sort last, regardless of direction.
        if (!a.build_date && !b.build_date) return 0;
        if (!a.build_date) return 1;
        if (!b.build_date) return -1;
        return a.build_date.localeCompare(b.build_date) * dir;
      }
      return a[key].localeCompare(b[key]) * dir;
    });
  }, [filtered, sort]);

  const shown = sorted.slice(0, DISPLAY_CAP);

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search builds…"
          className="h-9 w-80 rounded-md border border-neutral-300 bg-transparent px-3 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700"
        />
        <select
          value={system}
          onChange={(e) => setSystem(e.target.value)}
          className="h-9 w-48 rounded-md border border-neutral-300 bg-transparent px-3 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
        >
          <option value="">All systems</option>
          {systems.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="text-xs text-neutral-400">
          {filtered.length}
          {filtered.length !== builds.length ? ` of ${builds.length}` : ""}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">No builds match.</p>
      ) : (
        <table className="mt-4 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-200/80 text-left text-xs font-medium text-neutral-400 dark:border-neutral-800/80">
              <Th label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
              <th className="px-3 py-1.5">SHA-256</th>
              <Th label="System" sortKey="system" sort={sort} onSort={toggleSort} />
              <Th label="Date" sortKey="build_date" sort={sort} onSort={toggleSort} />
              <Th label="Files" sortKey="file_count" sort={sort} onSort={toggleSort} align="right" />
              <Th label="Size" sortKey="total_size" sort={sort} onSort={toggleSort} align="right" last />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900/60">
            {shown.map((b) => (
              <tr key={b.sha256} className="hover:bg-neutral-50 dark:hover:bg-neutral-900/40">
                <td className="h-full p-0 font-medium first:[&>a]:pl-0">
                  <RowLink href={`/builds/${b.sha256}`} focusable className="px-3 hover:underline">{b.name}</RowLink>
                </td>
                <td className="h-full p-0">
                  <RowLink href={`/builds/${b.sha256}`} className="px-3 font-mono text-xs text-neutral-400">{b.sha256.slice(0, 16)}…</RowLink>
                </td>
                <td className="h-full p-0">
                  <RowLink href={`/builds/${b.sha256}`} className="px-3">
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">{b.system}</span>
                  </RowLink>
                </td>
                <td className="h-full p-0">
                  <RowLink href={`/builds/${b.sha256}`} className="px-3 font-mono text-xs text-neutral-500">{formatDate(b.build_date)}</RowLink>
                </td>
                <td className="h-full p-0">
                  <RowLink href={`/builds/${b.sha256}`} className="px-3 text-right tabular-nums text-neutral-500">{b.file_count}</RowLink>
                </td>
                <td className="h-full p-0 last:[&>a]:pr-0">
                  <RowLink href={`/builds/${b.sha256}`} className="px-3 text-right tabular-nums text-neutral-500">{humanSize(b.total_size)}</RowLink>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {filtered.length > DISPLAY_CAP && (
        <p className="mt-2 text-xs text-neutral-400">
          Showing first {DISPLAY_CAP} of {filtered.length} matches — refine your search.
        </p>
      )}
    </>
  );
}

function Th({
  label,
  sortKey,
  sort,
  onSort,
  align,
  last,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  onSort: (k: SortKey) => void;
  align?: "right";
  last?: boolean;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
      className={`p-0 ${align === "right" ? "text-right" : ""}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`flex w-full items-center gap-1 px-3 py-1.5 font-medium hover:text-neutral-600 dark:hover:text-neutral-200 ${
          align === "right" ? "justify-end" : ""
        } ${last ? "pr-0" : ""} ${sortKey === "name" ? "pl-0" : ""}`}
      >
        {label}
        <span className={`relative top-px text-[8px] leading-none ${active ? "" : "invisible"}`}>{sort.dir === 1 ? "▲" : "▼"}</span>
      </button>
    </th>
  );
}
