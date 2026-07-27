// Server component: one game's magazine coverage, grouped with reviews (and
// their score grids) first. Data comes pre-fetched from the page.

import Link from "next/link";
import { extractAnchor, issueHref, magThumbUrl } from "@/lib/mag/hrefs";
import type { CoverageItem } from "@/lib/mag/queries";

const GROUPS: { title: string; kinds: string[] }[] = [
  { title: "Reviews", kinds: ["review"] },
  { title: "Previews", kinds: ["preview"] },
  { title: "Guides and tips", kinds: ["strategy", "tips"] },
  { title: "Features and interviews", kinds: ["feature", "interview", "news", "rumor", "column"] },
  { title: "Advertising", kinds: ["ad"] },
  { title: "Charts and scores", kinds: ["chart", "high_scores", "calendar"] },
];

function scoreLine(data: Record<string, unknown>): string | null {
  const scores = Array.isArray(data.scores) ? (data.scores as Record<string, unknown>[]) : [];
  const average = data.average as { value?: unknown; scale?: unknown } | undefined;
  const parts = scores.slice(0, 6).map((s) => `${String(s.reviewer ?? "?")} ${String(s.value ?? "?")}`);
  if (average?.value !== undefined) {
    parts.push(`avg ${String(average.value)}${average.scale ? `/${String(average.scale)}` : ""}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

export default function GameMagCoverage({ coverage }: { coverage: CoverageItem[] }) {
  if (coverage.length === 0) return null;
  const seen = new Set<string>(GROUPS.flatMap((g) => g.kinds));
  const rest = coverage.filter((c) => !seen.has(c.kind));

  return (
    <section className="mx-auto mt-10 max-w-4xl">
      <h2 className="text-lg font-medium">Magazine coverage</h2>
      <p className="mt-1 text-xs text-neutral-500">
        {coverage.length} indexed {coverage.length === 1 ? "appearance" : "appearances"} in the magazine archive.
      </p>
      {[...GROUPS, { title: "Elsewhere", kinds: [] }].map((g) => {
        const items = g.kinds.length ? coverage.filter((c) => g.kinds.includes(c.kind)) : rest;
        if (items.length === 0) return null;
        return (
          <div key={g.title} className="mt-5">
            <h3 className="text-sm font-semibold text-neutral-500">{g.title}</h3>
            <ul className="mt-2 space-y-2">
              {items.map((h) => {
                const scores = h.kind === "review" ? scoreLine(h.data) : null;
                return (
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
                          {h.magazine_title} {h.issue_label}
                          {h.cover_date ? (
                            <span className="font-normal text-neutral-500"> · {h.cover_date.slice(0, 7)}</span>
                          ) : null}
                        </div>
                        {scores ? (
                          <div className="text-xs font-medium text-emerald-800 dark:text-emerald-300">{scores}</div>
                        ) : (
                          <div className="text-xs text-neutral-500">
                            {h.title || h.section || h.kind.replace("_", " ")}
                            {h.title_printed && h.title_printed !== h.title ? ` (printed as "${h.title_printed}")` : ""}
                          </div>
                        )}
                        {h.summary_en && (
                          <div className="mt-0.5 line-clamp-1 text-xs text-neutral-600 dark:text-neutral-400">{h.summary_en}</div>
                        )}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
