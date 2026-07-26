"use client";

// The issue page body: page strip with extract-region overlays, kind filter,
// original/English toggle, and every extract as a card grouped by page. A
// lightweight lightbox opens crops and full pages (probe-then-ZoomPan, the
// MediaViewer recipe). Deep links use plain #x-<id> anchors, so search hits
// land on the card without any history choreography.

import Link from "next/link";
import { useMemo, useState } from "react";
import ZoomPan from "../../../builds/[buildId]/ZoomPan";
import { extractAnchor, magBlobUrl, magThumbUrl, personHref } from "@/lib/mag/hrefs";
import ModTools from "./ModTools";

export interface IssuePageItem {
  pdf_index: number;
  printed_label: string | null;
  image_sha256: string | null;
  width: number | null;
  height: number | null;
}

export interface RegionItem {
  id: number;
  seq: number;
  pdf_index: number;
  printed_label: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  crop_sha256: string | null;
  page_sha256: string | null;
  page_width: number | null;
  page_height: number | null;
}

export interface IssueExtractItem {
  id: number;
  kind: string;
  section: string | null;
  seq: number;
  title: string | null;
  language: string;
  /** Previews — the server truncates; `truncated` says the full text is a
   *  fetch away (GET /api/mag/extracts/<id>). */
  text_original: string | null;
  text_en: string | null;
  truncated: boolean;
  translation: "machine" | "human" | null;
  summary_en: string | null;
  data: Record<string, unknown>;
  is_fictional: boolean;
  sponsored: boolean;
  content_warning: string | null;
  status: string;
  regions: RegionItem[];
  games: { game_id: number; name: string; system: string; slug: string | null; role: string; title_printed: string | null }[];
  people: { person_id: number; slug: string; name: string; name_original: string | null; kind: string; role: string }[];
  systems: string[];
  tags: { slug: string; kind: string; name: string }[];
}

const KIND_TINT: Record<string, string> = {
  review: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  preview: "bg-teal-100 text-teal-900 dark:bg-teal-900/40 dark:text-teal-200",
  interview: "bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-200",
  strategy: "bg-cyan-100 text-cyan-900 dark:bg-cyan-900/40 dark:text-cyan-200",
  tips: "bg-cyan-100 text-cyan-900 dark:bg-cyan-900/40 dark:text-cyan-200",
  chart: "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200",
  high_scores: "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/40 dark:text-indigo-200",
  ad: "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200",
  ad_index: "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200",
  comic: "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-900/40 dark:text-fuchsia-200",
  fiction: "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-900/40 dark:text-fuchsia-200",
  news: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  rumor: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
};

function kindChip(kind: string): string {
  return KIND_TINT[kind] ?? "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
}

interface LightboxItem {
  url: string;
  caption: string;
}

function Lightbox({ item, onClose }: { item: LightboxItem; onClose: () => void }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/75 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      tabIndex={-1}
    >
      <div className="flex items-center justify-between px-4 py-2 text-sm text-neutral-200">
        <span className="truncate">{item.caption}</span>
        <button onClick={onClose} className="rounded px-2 py-1 hover:bg-white/10" aria-label="Close">
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1" onClick={(e) => e.stopPropagation()}>
        {size ? (
          <ZoomPan contentSize={size} className="h-full w-full">
            {(scale) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.url}
                alt={item.caption}
                width={size.width * scale}
                height={size.height * scale}
                style={{ imageRendering: scale > 1 ? "pixelated" : "auto" }}
                draggable={false}
              />
            )}
          </ZoomPan>
        ) : (
          // Probe render: measure the natural size, then hand off to ZoomPan.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.url}
            alt={item.caption}
            className="mx-auto max-h-full max-w-full object-contain"
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth && img.naturalHeight) {
                setSize({ width: img.naturalWidth, height: img.naturalHeight });
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Compact structured-data rendering per kind: score rows, fact boxes,
 *  chart/high-score tables, ad product lists. Anything unrecognized simply
 *  doesn't render — data is schemaless by design. */
function DataBlock({ data }: { data: Record<string, unknown> }) {
  const scores = Array.isArray(data.scores) ? (data.scores as Record<string, unknown>[]) : null;
  const average = data.average as { value?: unknown; scale?: unknown } | undefined;
  const axes = Array.isArray(data.axes) ? (data.axes as Record<string, unknown>[]) : null;
  const factBox = data.fact_box as Record<string, unknown> | undefined;
  const entries = Array.isArray(data.entries) ? (data.entries as Record<string, unknown>[]) : null;
  const products = Array.isArray(data.products) ? (data.products as Record<string, unknown>[]) : null;
  const advertiser = typeof data.advertiser === "string" ? data.advertiser : null;
  const source = typeof data.source === "string" ? data.source : null;

  const hasAny = scores?.length || axes?.length || factBox || entries?.length || products?.length || advertiser;
  if (!hasAny) return null;

  return (
    <div className="mt-2 space-y-2 text-xs">
      {scores && scores.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {scores.map((s, i) => (
            <span key={i} className="rounded border border-neutral-300 px-1.5 py-0.5 dark:border-neutral-700">
              <span className="text-neutral-500">{String(s.reviewer ?? "?")}</span>{" "}
              <strong>{String(s.value ?? "?")}</strong>
              {s.scale ? <span className="text-neutral-400">/{String(s.scale)}</span> : null}
            </span>
          ))}
          {average?.value !== undefined && (
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-semibold text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200">
              avg {String(average.value)}
              {average.scale ? `/${String(average.scale)}` : ""}
            </span>
          )}
        </div>
      )}
      {axes && axes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {axes.map((a, i) => (
            <span key={i} className="rounded border border-neutral-300 px-1.5 py-0.5 dark:border-neutral-700">
              <span className="text-neutral-500">{String(a.axis ?? "?")}</span> <strong>{String(a.value ?? "?")}</strong>
              {a.scale ? <span className="text-neutral-400">/{String(a.scale)}</span> : null}
            </span>
          ))}
        </div>
      )}
      {factBox && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
          {Object.entries(factBox)
            .filter(([, v]) => v !== null && v !== undefined && v !== "")
            .slice(0, 12)
            .map(([k, v]) => (
              <div key={k} className="flex gap-1">
                <dt className="text-neutral-500">{k.replace(/_/g, " ")}:</dt>
                <dd className="truncate font-medium">{String(v)}</dd>
              </div>
            ))}
        </dl>
      )}
      {advertiser && (
        <p>
          <span className="text-neutral-500">advertiser:</span> <strong>{advertiser}</strong>
          {typeof data.reader_service_no === "number" || typeof data.reader_service_no === "string" ? (
            <span className="text-neutral-500"> · reader service #{String(data.reader_service_no)}</span>
          ) : null}
        </p>
      )}
      {products && products.length > 0 && (
        <p className="text-neutral-600 dark:text-neutral-400">
          {products
            .slice(0, 12)
            .map((p) => [p.title_printed, p.system_printed ? `(${String(p.system_printed)})` : ""].filter(Boolean).join(" "))
            .join(" · ")}
          {products.length > 12 ? ` · +${products.length - 12} more` : ""}
        </p>
      )}
      {entries && entries.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-0 text-left">
            <tbody>
              {entries.slice(0, 15).map((row, i) => (
                <tr key={i} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800">
                  {["rank", "prev_rank", "player", "title_printed", "event", "value", "points", "comment"]
                    .filter((c) => row[c] !== undefined && row[c] !== null && row[c] !== "")
                    .slice(0, 5)
                    .map((c) => (
                      <td key={c} className="py-0.5 pr-3 align-top">
                        {c === "rank" ? <strong>{String(row[c])}</strong> : String(row[c])}
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length > 15 && <p className="text-neutral-400">+{entries.length - 15} more rows</p>}
        </div>
      )}
      {source && <p className="text-neutral-400">source: {source.replace(/_/g, " ")}</p>}
    </div>
  );
}

function ExtractText({
  item,
  lang,
}: {
  item: IssueExtractItem;
  lang: "original" | "en";
}) {
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState<{ text_original: string; text_en: string | null } | null>(null);
  const [loading, setLoading] = useState(false);

  const text =
    lang === "en"
      ? (full?.text_en ?? item.text_en) ?? item.summary_en ?? (full?.text_original ?? item.text_original)
      : (full?.text_original ?? item.text_original);
  if (!text && !item.summary_en) return null;

  async function expand() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (item.truncated && !full) {
      setLoading(true);
      try {
        const r = await fetch(`/api/mag/extracts/${item.id}`, { cache: "no-store" });
        if (r.ok) {
          const data = (await r.json()) as { extract: { text_original: string; text_en: string | null } };
          setFull({ text_original: data.extract.text_original, text_en: data.extract.text_en });
        }
      } finally {
        setLoading(false);
      }
    }
    setExpanded(true);
  }

  const clamped = !expanded;
  return (
    <div className="mt-2">
      {lang === "en" && !item.text_en && item.summary_en && text === item.summary_en && (
        <p className="mb-1 text-[10px] uppercase tracking-wide text-neutral-400">summary</p>
      )}
      <p
        className={`whitespace-pre-wrap text-sm leading-relaxed text-neutral-800 dark:text-neutral-200 ${clamped ? "line-clamp-4" : ""}`}
        lang={lang === "en" ? "en" : item.language}
      >
        {text}
      </p>
      {(item.truncated || (text && text.length > 350)) && (
        <button onClick={expand} className="mt-1 text-xs text-sky-700 hover:underline dark:text-sky-300">
          {loading ? "loading…" : expanded ? "collapse" : "read all"}
        </button>
      )}
      {lang === "en" && item.translation === "machine" && item.text_en && (
        <p className="mt-1 text-[10px] uppercase tracking-wide text-neutral-400">machine translation</p>
      )}
    </div>
  );
}

export default function IssueBrowser({
  issueId,
  binding,
  pages,
  extracts,
  pagesPublic,
  moderator,
}: {
  issueId: number;
  binding: "ltr" | "rtl";
  pages: IssuePageItem[];
  extracts: IssueExtractItem[];
  pagesPublic: boolean;
  moderator: boolean;
}) {
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [lang, setLang] = useState<"original" | "en">("original");
  const [box, setBox] = useState<LightboxItem | null>(null);

  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of extracts) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [extracts]);

  const hasTranslations = useMemo(
    () => extracts.some((e) => e.text_en || (e.language && e.language !== "en" && e.summary_en)),
    [extracts]
  );

  const visible = kindFilter ? extracts.filter((e) => e.kind === kindFilter) : extracts;

  // Group by first region's page, in reading order.
  const byPage = useMemo(() => {
    const groups = new Map<number, IssueExtractItem[]>();
    for (const e of visible) {
      const page = e.regions[0]?.pdf_index ?? 0;
      const list = groups.get(page) ?? [];
      list.push(e);
      groups.set(page, list);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [visible]);

  const regionsByPage = useMemo(() => {
    const m = new Map<number, { id: number; x: number; y: number; w: number; h: number; rejected: boolean }[]>();
    for (const e of extracts) {
      for (const r of e.regions) {
        const list = m.get(r.pdf_index) ?? [];
        list.push({ id: e.id, x: r.x, y: r.y, w: r.w, h: r.h, rejected: e.status === "rejected" });
        m.set(r.pdf_index, list);
      }
    }
    return m;
  }, [extracts]);

  const pageLabel = (p: IssuePageItem) => p.printed_label ?? `pdf ${p.pdf_index}`;

  return (
    <div className="mx-auto mt-8 max-w-5xl">
      {box && <Lightbox item={box} onClose={() => setBox(null)} />}

      {pagesPublic && pages.some((p) => p.image_sha256) && (
        <section aria-label="Pages">
          <div className="flex gap-2 overflow-x-auto pb-2" dir={binding === "rtl" ? "rtl" : undefined}>
            {pages.map((p) => (
              <figure key={p.pdf_index} className="w-24 shrink-0">
                <div className="relative">
                  {p.image_sha256 ? (
                    <button
                      onClick={() =>
                        setBox({ url: magBlobUrl(p.image_sha256!), caption: `Page ${pageLabel(p)}` })
                      }
                      className="block w-full"
                      aria-label={`Open page ${pageLabel(p)}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={magThumbUrl(p.image_sha256, 500)}
                        alt={`Page ${pageLabel(p)}`}
                        className="w-full rounded-sm border border-neutral-200 dark:border-neutral-800"
                        loading="lazy"
                      />
                    </button>
                  ) : (
                    <div className="flex aspect-[3/4] w-full items-center justify-center rounded-sm border border-dashed border-neutral-300 text-[10px] text-neutral-400 dark:border-neutral-700">
                      …
                    </div>
                  )}
                  {(regionsByPage.get(p.pdf_index) ?? []).length > 0 && (
                    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                      {(regionsByPage.get(p.pdf_index) ?? []).map((r, i) => (
                        <a key={`${r.id}-${i}`} href={`#${extractAnchor(r.id)}`} className="pointer-events-auto">
                          <rect
                            x={r.x * 100}
                            y={r.y * 100}
                            width={r.w * 100}
                            height={r.h * 100}
                            className={
                              r.rejected
                                ? "fill-transparent stroke-red-400/70"
                                : "fill-sky-400/10 stroke-sky-500/70 hover:fill-sky-400/25"
                            }
                            strokeWidth="1"
                            vectorEffect="non-scaling-stroke"
                          />
                        </a>
                      ))}
                    </svg>
                  )}
                </div>
                <figcaption className="mt-0.5 text-center text-[10px] text-neutral-500">{pageLabel(p)}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      <div className="sticky top-0 z-10 mt-4 flex flex-wrap items-center gap-1.5 border-b border-neutral-200 bg-[var(--background)] py-2 text-xs dark:border-neutral-800">
        <button
          onClick={() => setKindFilter(null)}
          className={`rounded px-1.5 py-0.5 ${kindFilter === null ? "bg-neutral-800 text-white dark:bg-neutral-200 dark:text-neutral-900" : "bg-neutral-100 dark:bg-neutral-800"}`}
        >
          all {extracts.length}
        </button>
        {kinds.map(([k, n]) => (
          <button
            key={k}
            onClick={() => setKindFilter(kindFilter === k ? null : k)}
            className={`rounded px-1.5 py-0.5 ${kindFilter === k ? "bg-neutral-800 text-white dark:bg-neutral-200 dark:text-neutral-900" : kindChip(k)}`}
          >
            {k.replace("_", " ")} {n}
          </button>
        ))}
        {hasTranslations && (
          <span className="ml-auto inline-flex overflow-hidden rounded border border-neutral-300 dark:border-neutral-700">
            <button
              onClick={() => setLang("original")}
              className={`px-2 py-0.5 ${lang === "original" ? "bg-neutral-800 text-white dark:bg-neutral-200 dark:text-neutral-900" : ""}`}
            >
              original
            </button>
            <button
              onClick={() => setLang("en")}
              className={`px-2 py-0.5 ${lang === "en" ? "bg-neutral-800 text-white dark:bg-neutral-200 dark:text-neutral-900" : ""}`}
            >
              english
            </button>
          </span>
        )}
      </div>

      {byPage.map(([page, items]) => (
        <section key={page} className="mt-6">
          <h2 className="text-sm font-semibold text-neutral-500">
            Page {items[0]?.regions[0]?.printed_label ?? `pdf ${page}`}
          </h2>
          <div className="mt-2 space-y-3">
            {items.map((e) => (
              <article
                key={e.id}
                id={extractAnchor(e.id)}
                className={`flex scroll-mt-24 gap-3 rounded-md border p-3 target:border-sky-500 target:ring-1 target:ring-sky-500 ${
                  e.status === "rejected"
                    ? "border-red-300 opacity-60 dark:border-red-900"
                    : "border-neutral-200 dark:border-neutral-800"
                }`}
              >
                <div className="w-28 shrink-0 sm:w-36">
                  {e.regions[0]?.crop_sha256 ? (
                    <button
                      onClick={() =>
                        setBox({
                          url: magBlobUrl(e.regions[0].crop_sha256!),
                          caption: e.title ?? e.section ?? e.kind,
                        })
                      }
                      className="block w-full"
                      aria-label="Open excerpt"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={magThumbUrl(e.regions[0].crop_sha256, 500)}
                        alt=""
                        className="w-full rounded-sm border border-neutral-200 dark:border-neutral-800"
                        loading="lazy"
                      />
                    </button>
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center rounded-sm border border-dashed border-neutral-300 text-[10px] text-neutral-400 dark:border-neutral-700">
                      cropping…
                    </div>
                  )}
                  {e.regions.length > 1 && (
                    <p className="mt-0.5 text-center text-[10px] text-neutral-400">
                      {e.regions.length} regions
                    </p>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className={`rounded px-1.5 py-0.5 font-medium ${kindChip(e.kind)}`}>
                      {e.kind.replace("_", " ")}
                    </span>
                    {e.section && <span className="text-neutral-500">{e.section}</span>}
                    {e.is_fictional && (
                      <span className="rounded bg-fuchsia-100 px-1.5 py-0.5 text-fuchsia-900 dark:bg-fuchsia-900/40 dark:text-fuchsia-200">
                        fictional
                      </span>
                    )}
                    {e.sponsored && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                        sponsored
                      </span>
                    )}
                    {e.content_warning && (
                      <span
                        className="rounded bg-red-100 px-1.5 py-0.5 text-red-900 dark:bg-red-900/40 dark:text-red-200"
                        title={e.content_warning}
                      >
                        content note
                      </span>
                    )}
                    {moderator && e.status !== "auto" && (
                      <span
                        className={`rounded px-1.5 py-0.5 ${
                          e.status === "rejected"
                            ? "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200"
                            : "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200"
                        }`}
                      >
                        {e.status}
                      </span>
                    )}
                  </div>
                  {(e.title || e.summary_en) && (
                    <h3 className="mt-1 text-sm font-medium">
                      {e.title ?? e.summary_en}
                    </h3>
                  )}

                  {(e.games.length > 0 || e.people.length > 0 || e.systems.length > 0 || e.tags.length > 0) && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
                      {e.games.map((g) => (
                        <Link
                          key={g.game_id}
                          href={g.slug ? `/games/${g.slug}` : "#"}
                          className="rounded bg-sky-100 px-1.5 py-0.5 font-medium text-sky-900 hover:bg-sky-200 dark:bg-sky-900/40 dark:text-sky-200 dark:hover:bg-sky-900/70"
                          title={g.title_printed && g.title_printed !== g.name ? `printed as "${g.title_printed}"` : undefined}
                        >
                          {g.name}
                          {g.system ? <span className="font-normal text-sky-700/70 dark:text-sky-300/70"> · {g.system}</span> : null}
                        </Link>
                      ))}
                      {e.people.map((p) => (
                        <Link
                          key={`${p.person_id}-${p.role}`}
                          href={personHref(p.slug)}
                          className="rounded bg-violet-100 px-1.5 py-0.5 font-medium text-violet-900 hover:bg-violet-200 dark:bg-violet-900/40 dark:text-violet-200 dark:hover:bg-violet-900/70"
                          title={p.kind === "persona" ? `${p.role} (persona)` : p.role}
                        >
                          {p.name}
                        </Link>
                      ))}
                      {e.systems.map((s) => (
                        <span key={s} className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">{s}</span>
                      ))}
                      {e.tags.map((t) => (
                        <span
                          key={t.slug}
                          className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400"
                          title={t.kind}
                        >
                          {t.name}
                        </span>
                      ))}
                    </div>
                  )}

                  <DataBlock data={e.data} />
                  <ExtractText item={e} lang={lang} />

                  {moderator && <ModTools extract={e} />}
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}

      {visible.length === 0 && (
        <p className="mt-10 text-sm text-neutral-500">
          {extracts.length === 0 ? "No extracts ingested yet." : "Nothing matches this filter."}
        </p>
      )}
      <p className="mt-10 text-[10px] text-neutral-400">issue #{issueId}</p>
    </div>
  );
}
