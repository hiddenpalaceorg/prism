"use client";

// GitHub-style commit activity calendar: one grid per year, week columns,
// one 9px cell per day. Year rows come from the full log so the layout never
// jumps, while the counts follow the message filter — filter for "sound" and
// the calendar shows when the sound work happened. Colors are a single blue
// ramp stepped light-to-dark (flipped to recede toward the dark surface in
// dark mode); the 2px cell gap is the only separator.

import { useMemo } from "react";
import {
  commitYears,
  dayCounts,
  DAY_NAMES,
  levelFor,
  levelThresholds,
  yearGrid,
} from "@/lib/commit-heatmap";
import type { RepoCommit } from "@/lib/repo-manifest";

const CELL = 9;
const GAP = 2;
const PITCH = CELL + GAP;
const LABEL_H = 14; // month-label band above each grid
const GRID_H = LABEL_H + 7 * PITCH - GAP;

// Level 0 (no commits) is neutral; 1-4 are one blue ramp, both schemes
// validated against their surfaces (see lib/commit-heatmap.ts for bucketing).
const LEVEL_CLASS = [
  "fill-neutral-200 dark:fill-neutral-800",
  "fill-[#86b6ef] dark:fill-[#184f95]",
  "fill-[#3987e5] dark:fill-[#2a78d6]",
  "fill-[#1c5cab] dark:fill-[#6da7ec]",
  "fill-[#0d366b] dark:fill-[#b7d3f6]",
];

export default function RepoCommitHeatmap({
  commits,
  shown,
}: {
  /** The full log — fixes which year rows exist. */
  commits: RepoCommit[];
  /** The filtered log — drives the counts. */
  shown: RepoCommit[];
}) {
  const grids = useMemo(() => commitYears(commits).map(yearGrid), [commits]);
  const { counts, thresholds } = useMemo(() => {
    const counts = dayCounts(shown);
    return { counts, thresholds: levelThresholds(counts) };
  }, [shown]);

  return (
    <div className="mt-3 overflow-x-auto">
      <div className="flex min-w-max flex-col gap-2">
        {grids.map((g) => (
          <div key={g.year} className="flex gap-2">
            <span className="w-8 shrink-0 pt-[15px] text-right font-mono text-[10px] leading-none text-neutral-500">
              {g.year}
            </span>
            <svg width={g.weeks * PITCH - GAP} height={GRID_H} role="img" aria-label={`Commits by day, ${g.year}`}>
              {g.months.map((m) => (
                <text key={m.label} x={m.week * PITCH} y={9} className="fill-neutral-400 font-mono text-[9px]">
                  {m.label}
                </text>
              ))}
              {g.days.map((d) => {
                const n = counts.get(d.key) ?? 0;
                return (
                  // The transparent 2px stroke doubles as hit-area padding;
                  // on hover it colors in as the lift ring.
                  <rect
                    key={d.key}
                    x={d.week * PITCH}
                    y={LABEL_H + d.dow * PITCH}
                    width={CELL}
                    height={CELL}
                    rx={2}
                    strokeWidth={2}
                    className={`${LEVEL_CLASS[levelFor(n, thresholds)]} stroke-transparent hover:stroke-neutral-400 dark:hover:stroke-neutral-500`}
                  >
                    <title>
                      {`${n === 0 ? "No commits" : n === 1 ? "1 commit" : `${n} commits`} on ${DAY_NAMES[d.dow]} ${d.key}`}
                    </title>
                  </rect>
                );
              })}
            </svg>
          </div>
        ))}
        <div className="flex items-center justify-end gap-1 text-[10px] text-neutral-400">
          <span>Less</span>
          <svg width={LEVEL_CLASS.length * PITCH - GAP} height={CELL} aria-hidden="true">
            {LEVEL_CLASS.map((cls, i) => (
              <rect key={cls} x={i * PITCH} width={CELL} height={CELL} rx={2} className={cls} />
            ))}
          </svg>
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
