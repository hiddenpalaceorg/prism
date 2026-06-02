"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { TIERS, applicableTiers, fusedScore, type FusedBuild, type TierKey } from "@/lib/tiers";

const MIN_SCORE = 0.01; // > 1%
const MAX_ROWS = 50;

export default function SimilarBuilds({ builds, queryCaps }: { builds: FusedBuild[]; queryCaps: TierKey[] }) {
  const qCaps = useMemo(() => new Set(queryCaps), [queryCaps]);
  const [active, setActive] = useState<Set<TierKey>>(() => new Set(TIERS.map((t) => t.key)));

  const toggle = (k: TierKey) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const ranked = useMemo(
    () =>
      builds
        .map((b) => {
          const applic = applicableTiers(active, qCaps, b.caps);
          return { b, applic, score: fusedScore(b.scores, applic) };
        })
        .filter((x) => x.score > MIN_SCORE)
        .sort((a, c) => c.score - a.score)
        .slice(0, MAX_ROWS),
    [builds, active, qCaps]
  );

  if (builds.length === 0) return null;

  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-medium">Similar builds</h2>
        <span className="text-xs text-neutral-400">
          {ranked.length} shown{ranked.length === MAX_ROWS ? ` (top ${MAX_ROWS})` : ""}
        </span>
      </div>

      {/* Tier filter — toggles which tiers feed the weighted score; % is the tier's weight.
          Tiers this build has no data for are disabled (they can never apply). */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {TIERS.map((t) => {
          const supported = qCaps.has(t.key);
          const on = supported && active.has(t.key);
          return (
            <button
              key={t.key}
              onClick={() => supported && toggle(t.key)}
              disabled={!supported}
              aria-pressed={on}
              title={supported ? undefined : "this build has no data for this tier"}
              className={`rounded-full border px-2.5 py-1 text-xs transition ${
                !supported
                  ? "cursor-not-allowed border-neutral-200 text-neutral-300 line-through dark:border-neutral-800 dark:text-neutral-600"
                  : on
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                    : "border-neutral-300 text-neutral-400 dark:border-neutral-700"
              }`}
            >
              {t.label} <span className="opacity-60">{Math.round(t.weight * 100)}%</span>
            </button>
          );
        })}
      </div>

      {ranked.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">
          {active.size === 0 ? "Select at least one tier." : "No builds above 1% for the selected tiers."}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">
          {ranked.map(({ b, score, applic }) => (
            <li key={b.sha256} className="py-2.5">
              <div className="flex items-center justify-between gap-4">
                <Link href={`/builds/${b.sha256}`} className="min-w-0 truncate font-medium hover:underline">
                  {b.name}
                </Link>
                <span className="flex shrink-0 items-center gap-2 text-xs">
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">{b.system}</span>
                  <span className="w-12 text-right font-mono font-semibold">{(score * 100).toFixed(1)}%</span>
                </span>
              </div>
              {/* per-tier contributions (active tiers this build actually matched) */}
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-neutral-400">
                {TIERS.filter((t) => applic.has(t.key) && (b.scores[t.key] ?? 0) > 0).map((t) => (
                  <span key={t.key}>
                    {t.label} <span className="font-mono">{Math.round((b.scores[t.key] as number) * 100)}%</span>
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
