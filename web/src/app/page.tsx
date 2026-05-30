"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Hit {
  sha256: string;
  name: string;
  system: string;
  sim?: number | null;
}

export default function Home() {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<string>("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const doSearch = useCallback(async (term: string) => {
    if (!term.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
      const data = await res.json();
      setMode(data.mode ?? "");
      setHits(data.results ?? []);
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
        <h1 className="text-2xl font-semibold tracking-tight">Curator</h1>
        <Link href="/moderate" className="text-sm text-neutral-500 hover:underline">Moderation &rarr;</Link>
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        Search known builds by filename or hash.
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
                  <Link href={`/build/${h.sha256}`} className="font-medium hover:underline">
                    {h.name}
                  </Link>
                  <div className="mt-0.5 flex gap-3 text-xs text-neutral-500">
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
                      {h.system}
                    </span>
                    <span className="font-mono">{h.sha256.slice(0, 16)}…</span>
                    {h.sim != null && <span>sim {h.sim.toFixed(2)}</span>}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {!loading && searched && hits.length === 0 && (
          <p className="text-sm text-neutral-500">No matches.</p>
        )}
      </div>
    </main>
  );
}
