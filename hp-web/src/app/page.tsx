"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { buildHref } from "@/lib/slug";

interface Hit {
  sha256: string;
  name: string;
  system: string;
  sim?: number | null;
  /** Set when the build matched through a file inside it. */
  file?: string;
}

interface MagHit {
  id: number;
  kind: string;
  title: string | null;
  section: string | null;
  issue_slug: string;
  issue_label: string;
  cover_date: string | null;
  magazine_slug: string;
  magazine_title: string;
}

export default function Home() {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<string>("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [magHits, setMagHits] = useState<MagHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const doSearch = useCallback(async (term: string) => {
    if (!term.trim()) return;
    setLoading(true);
    try {
      // Magazine hits ride alongside; a hash-looking query skips them.
      const magPromise = /^[0-9a-fA-F]{8,}$/.test(term.trim())
        ? Promise.resolve<MagHit[]>([])
        : fetch(`/api/mag/search?q=${encodeURIComponent(term)}&limit=5`)
            .then((r) => r.json())
            .then((d) => (d.results as MagHit[]) ?? [])
            .catch(() => []);
      const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
      const data = await res.json();
      setMode(data.mode ?? "");
      setHits(data.results ?? []);
      setMagHits(await magPromise);
      setSearched(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Deep-link support: /?q=<term> (e.g. a sha256 opened from the macOS app).
  useEffect(() => {
    const term = new URLSearchParams(window.location.search).get("q");
    if (term) {
      setQ(term);
      void doSearch(term);
    }
  }, [doSearch]);

  function runSearch(e: React.FormEvent) {
    e.preventDefault();
    void doSearch(q);
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Prism</h1>
        <span className="flex gap-4 text-sm text-neutral-500">
          <Link href="/builds" className="hover:underline">Browse builds &rarr;</Link>
          <Link href="/magazines" className="hover:underline">Magazines &rarr;</Link>
          <Link href="/moderate" className="hover:underline">Moderation &rarr;</Link>
        </span>
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        Search known builds by title, filename, or hash.
      </p>

      <form onSubmit={runSearch} className="mt-6 flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filename, title, or md5/sha1/sha256…"
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
        >
          Search
        </button>
      </form>

      <div className="mt-6">
        {loading && <p className="text-sm text-neutral-500">Searching…</p>}
        {!loading && hits.length > 0 && (
          <>
            <p className="mb-2 text-xs uppercase tracking-wide text-neutral-400">
              {hits.length} result{hits.length === 1 ? "" : "s"} · {mode} match
            </p>
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {hits.map((h) => (
                <li key={h.sha256} className="py-3">
                  <Link href={buildHref(h.sha256, h.name)} className="font-medium hover:underline">
                    {h.name}
                  </Link>
                  <div className="mt-0.5 flex gap-3 text-xs text-neutral-500">
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
                      {h.system || "unknown"}
                    </span>
                    <span className="font-mono">{h.sha256.slice(0, 16)}…</span>
                    {h.file && (
                      <span className="min-w-0 truncate font-mono" title={h.file}>
                        {h.file}
                      </span>
                    )}
                    {h.sim != null && <span>sim {h.sim.toFixed(2)}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {!loading && magHits.length > 0 && (
          <div className="mt-8">
            <p className="mb-2 text-xs uppercase tracking-wide text-neutral-400">In magazines</p>
            <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {magHits.map((h) => (
                <li key={h.id} className="py-3">
                  <Link
                    href={`/magazines/${h.magazine_slug}/${h.issue_slug}#x-${h.id}`}
                    className="font-medium hover:underline"
                  >
                    {h.title || h.section || h.kind.replace("_", " ")}
                  </Link>
                  <div className="mt-0.5 flex gap-3 text-xs text-neutral-500">
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
                      {h.kind.replace("_", " ")}
                    </span>
                    <span>
                      {h.magazine_title} {h.issue_label}
                      {h.cover_date ? ` · ${h.cover_date.slice(0, 7)}` : ""}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <Link
              href={`/magazines?q=${encodeURIComponent(q)}`}
              className="mt-2 inline-block text-xs text-sky-700 hover:underline dark:text-sky-300"
            >
              All magazine matches &rarr;
            </Link>
          </div>
        )}
        {!loading && searched && hits.length === 0 && magHits.length === 0 && (
          <p className="text-sm text-neutral-500">No matches.</p>
        )}
      </div>
    </main>
  );
}
