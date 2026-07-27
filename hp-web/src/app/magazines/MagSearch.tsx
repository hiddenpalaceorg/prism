"use client";

// Extract search box for /magazines: full text across every issue, with
// magazine/kind/system/language/date filters. Quote the query ("exact
// phrase") for exact substring matching (also the way to search Japanese
// text). URL-driven like the builds browser: state lives in
// ?q=&magazine=&kind=&system=&language=&from=&to=, so results are shareable
// and survive reloads.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { EXTRACT_KINDS } from "@/lib/mag/kinds";
import { extractAnchor, issueHref, magThumbUrl } from "@/lib/mag/hrefs";

interface Hit {
  id: number;
  kind: string;
  section: string | null;
  title: string | null;
  language: string;
  summary_en: string | null;
  snippet: string | null;
  issue_slug: string;
  issue_label: string;
  cover_date: string | null;
  magazine_slug: string;
  magazine_title: string;
  crop_sha256: string | null;
}

/** Render a ts_headline/snippetFrom string, highlighting [[...]] spans. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/\[\[(.+?)\]\]/g);
  return (
    <span>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-amber-200 px-0.5 dark:bg-amber-700/60">{p}</mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </span>
  );
}

/** "1991" from a stored YYYY-MM-DD bound, for the year inputs. */
function yearOf(date: string): string {
  return /^\d{4}/.test(date) ? date.slice(0, 4) : "";
}

const selectClass =
  "rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900";

export default function MagSearch({
  magazines,
  systems,
  languages,
}: {
  magazines: { slug: string; title: string }[];
  systems: string[];
  languages: string[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [magazine, setMagazine] = useState(params.get("magazine") ?? "");
  const [kind, setKind] = useState(params.get("kind") ?? "");
  const [system, setSystem] = useState(params.get("system") ?? "");
  const [language, setLanguage] = useState(params.get("language") ?? "");
  // The API filters on full cover dates; the UI thinks in years. A deep link
  // with finer-than-year bounds still filters exactly, it just displays as
  // the year.
  const [fromYear, setFromYear] = useState(yearOf(params.get("from") ?? ""));
  const [toYear, setToYear] = useState(yearOf(params.get("to") ?? ""));
  // Results are keyed by the URL query they answered. Everything else is
  // derived: no fetch in flight has landed for the current URL -> busy; the
  // URL has no query -> nothing renders. No state-syncing effects.
  const [fetched, setFetched] = useState<{ key: string; hits: Hit[] } | null>(null);
  const seq = useRef(0);

  const urlQ = params.get("q") ?? "";
  const urlMagazine = params.get("magazine") ?? "";
  const urlKind = params.get("kind") ?? "";
  const urlSystem = params.get("system") ?? "";
  const urlLanguage = params.get("language") ?? "";
  const urlFrom = params.get("from") ?? "";
  const urlTo = params.get("to") ?? "";
  const urlKey = [urlQ, urlMagazine, urlKind, urlSystem, urlLanguage, urlFrom, urlTo].join("\0");

  useEffect(() => {
    if (!urlQ.trim()) return;
    const mine = ++seq.current;
    const query = new URLSearchParams({ q: urlQ });
    if (urlMagazine) query.set("magazine", urlMagazine);
    if (urlKind) query.set("kind", urlKind);
    if (urlSystem) query.set("system", urlSystem);
    if (urlLanguage) query.set("language", urlLanguage);
    if (urlFrom) query.set("from", urlFrom);
    if (urlTo) query.set("to", urlTo);
    fetch(`/api/mag/search?${query}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (seq.current === mine) setFetched({ key: urlKey, hits: (data.results as Hit[]) ?? [] });
      })
      .catch(() => {
        if (seq.current === mine) setFetched({ key: urlKey, hits: [] });
      });
  }, [urlQ, urlMagazine, urlKind, urlSystem, urlLanguage, urlFrom, urlTo, urlKey]);

  const hits = urlQ.trim() && fetched?.key === urlKey ? fetched.hits : null;
  const busy = !!urlQ.trim() && hits === null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams();
    if (q.trim()) next.set("q", q.trim());
    if (magazine) next.set("magazine", magazine);
    if (kind) next.set("kind", kind);
    if (system) next.set("system", system);
    if (language) next.set("language", language);
    if (/^\d{4}$/.test(fromYear)) next.set("from", `${fromYear}-01-01`);
    if (/^\d{4}$/.test(toYear)) next.set("to", `${toYear}-12-31`);
    router.replace(`/magazines${next.size ? `?${next}` : ""}`, { scroll: false });
  }

  return (
    <div className="mt-6">
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={'search all issues… (quote for "exact match")'}
          className="min-w-48 flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
          aria-label="Search magazine extracts"
        />
        <select
          value={magazine}
          onChange={(e) => setMagazine(e.target.value)}
          className={selectClass}
          aria-label="Magazine filter"
        >
          <option value="">all magazines</option>
          {magazines.map((m) => (
            <option key={m.slug} value={m.slug}>{m.title}</option>
          ))}
        </select>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className={selectClass}
          aria-label="Kind filter"
        >
          <option value="">all kinds</option>
          {EXTRACT_KINDS.map((k) => (
            <option key={k} value={k}>{k.replace("_", " ")}</option>
          ))}
        </select>
        <select
          value={system}
          onChange={(e) => setSystem(e.target.value)}
          className={selectClass}
          aria-label="System filter"
        >
          <option value="">all systems</option>
          {systems.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className={selectClass}
          aria-label="Language filter"
        >
          <option value="">any language</option>
          {languages.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <input
          value={fromYear}
          onChange={(e) => setFromYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="from yyyy"
          inputMode="numeric"
          className="w-24 rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
          aria-label="From year"
        />
        <input
          value={toYear}
          onChange={(e) => setToYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="to yyyy"
          inputMode="numeric"
          className="w-24 rounded-md border border-neutral-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700"
          aria-label="To year"
        />
        <button
          type="submit"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          Search
        </button>
      </form>

      {busy && <p className="mt-4 text-sm text-neutral-500">Searching…</p>}
      {hits && !busy && (
        <div className="mt-4">
          <p className="text-xs text-neutral-500">
            {hits.length === 0 ? "No matches." : `${hits.length} ${hits.length === 1 ? "match" : "matches"}`}
          </p>
          <ul className="mt-2 space-y-2">
            {hits.map((h) => (
              <li key={h.id}>
                <Link
                  href={`${issueHref(h.magazine_slug, h.issue_slug)}#${extractAnchor(h.id)}`}
                  className="flex gap-3 rounded-md border border-neutral-200 p-2 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
                >
                  {h.crop_sha256 && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={magThumbUrl(h.crop_sha256, 500)}
                      alt=""
                      className="h-16 w-16 shrink-0 rounded-sm bg-neutral-100 object-cover dark:bg-neutral-800"
                      loading="lazy"
                    />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {h.title || h.section || h.kind.replace("_", " ")}
                    </div>
                    <div className="text-xs text-neutral-500">
                      {h.magazine_title} · {h.issue_label}
                      {h.cover_date ? ` · ${h.cover_date.slice(0, 7)}` : ""} ·{" "}
                      <span className="rounded bg-neutral-100 px-1 py-0.5 dark:bg-neutral-800">{h.kind.replace("_", " ")}</span>
                    </div>
                    {(h.snippet || h.summary_en) && (
                      <div className="mt-0.5 line-clamp-2 text-xs text-neutral-600 dark:text-neutral-400">
                        {h.snippet ? <Snippet text={h.snippet} /> : h.summary_en}
                      </div>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
