"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import RowLink from "./RowLink";
import type { BuildListItem, BuildSortKey } from "@/lib/queries";

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

interface Props {
  rows: BuildListItem[];
  total: number;
  systems: string[];
  page: number; // 1-based
  perPage: number;
  q: string;
  system: string;
  sort: BuildSortKey;
  dir: "asc" | "desc";
}

// Thin URL-driven control: every filter/sort/page change updates the search
// params and the server re-queries — the client only ever holds one page.
export default function BuildsBrowser({ rows, total, systems, page, perPage, q, system, sort, dir }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [input, setInput] = useState(q);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const navigate = (
    next: Partial<{ q: string; system: string; sort: BuildSortKey; dir: "asc" | "desc"; page: number }>,
    replace = false
  ) => {
    const state = { q, system, sort, dir, page, ...next };
    const params = new URLSearchParams();
    if (state.q) params.set("q", state.q);
    if (state.system) params.set("system", state.system);
    if (state.sort !== "name") params.set("sort", state.sort);
    if (state.dir !== "asc") params.set("dir", state.dir);
    if (state.page > 1) params.set("page", String(state.page));
    const url = params.size ? `${pathname}?${params}` : pathname;
    startTransition(() => {
      if (replace) router.replace(url, { scroll: false });
      else router.push(url, { scroll: false });
    });
  };

  // Debounced live search; a new query always restarts from page 1.
  const onInput = (value: string) => {
    setInput(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => navigate({ q: value, page: 1 }, true), 300);
  };
  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  const toggleSort = (key: BuildSortKey) =>
    navigate(sort === key ? { dir: dir === "asc" ? "desc" : "asc", page: 1 } : { sort: key, dir: "asc", page: 1 });

  const pages = Math.max(Math.ceil(total / perPage), 1);

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={input}
          onChange={(e) => onInput(e.target.value)}
          placeholder="Search builds…"
          className="h-9 w-80 rounded-md border border-neutral-300 bg-transparent px-3 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-500 dark:border-neutral-700"
        />
        <select
          value={system}
          onChange={(e) => navigate({ system: e.target.value, page: 1 })}
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
          {total} match{total === 1 ? "" : "es"}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">No builds match.</p>
      ) : (
        <table className={`mt-4 w-full border-collapse text-sm ${isPending ? "opacity-60" : ""}`}>
          <thead>
            <tr className="border-b border-neutral-200/80 text-left text-xs font-medium text-neutral-400 dark:border-neutral-800/80">
              <Th label="Name" sortKey="name" sort={sort} dir={dir} onSort={toggleSort} />
              <th className="px-3 py-1.5">SHA-256</th>
              <Th label="System" sortKey="system" sort={sort} dir={dir} onSort={toggleSort} />
              <Th label="Date" sortKey="build_date" sort={sort} dir={dir} onSort={toggleSort} />
              <Th label="Files" sortKey="file_count" sort={sort} dir={dir} onSort={toggleSort} align="right" />
              <Th label="Size" sortKey="total_size" sort={sort} dir={dir} onSort={toggleSort} align="right" last />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900/60">
            {rows.map((b) => (
              <tr key={b.sha256} className="hover:bg-neutral-50 dark:hover:bg-neutral-900/40">
                <td className="h-full p-0 font-medium first:[&>a]:pl-0">
                  <RowLink href={`/builds/${b.sha256}`} focusable className="px-3 hover:underline">{b.name}</RowLink>
                </td>
                <td className="h-full p-0">
                  <RowLink href={`/builds/${b.sha256}`} className="px-3 font-mono text-xs text-neutral-400">{b.sha256.slice(0, 16)}…</RowLink>
                </td>
                <td className="h-full p-0">
                  <RowLink href={`/builds/${b.sha256}`} className="px-3">
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">{b.system || "unknown"}</span>
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

      {pages > 1 && (
        <div className="mt-4 flex items-center gap-3 text-sm text-neutral-500">
          <button
            className="rounded-md border border-neutral-300 px-2.5 py-1 hover:border-neutral-500 disabled:opacity-40 disabled:hover:border-neutral-300 dark:border-neutral-700"
            disabled={page <= 1 || isPending}
            onClick={() => navigate({ page: page - 1 })}
          >
            ← Prev
          </button>
          <span className="text-xs">
            page {page} of {pages}
          </span>
          <button
            className="rounded-md border border-neutral-300 px-2.5 py-1 hover:border-neutral-500 disabled:opacity-40 disabled:hover:border-neutral-300 dark:border-neutral-700"
            disabled={page >= pages || isPending}
            onClick={() => navigate({ page: page + 1 })}
          >
            Next →
          </button>
        </div>
      )}
    </>
  );
}

function Th({
  label,
  sortKey,
  sort,
  dir,
  onSort,
  align,
  last,
}: {
  label: string;
  sortKey: BuildSortKey;
  sort: BuildSortKey;
  dir: "asc" | "desc";
  onSort: (k: BuildSortKey) => void;
  align?: "right";
  last?: boolean;
}) {
  const active = sort === sortKey;
  return (
    <th
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
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
        <span className={`relative top-px text-[8px] leading-none ${active ? "" : "invisible"}`}>{dir === "asc" ? "▲" : "▼"}</span>
      </button>
    </th>
  );
}
