// Day-grid geometry and count bucketing for the commit activity calendar
// (RepoCommitHeatmap): one column per week, one cell per day, one grid per
// year. Pure data — no React — so the shapes are testable and the component
// stays a straight render.

import { identLocalDate, type RepoCommit } from "./repo-manifest";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface HeatmapDay {
  key: string; // "YYYY-MM-DD"
  week: number; // column, Sunday-started weeks from Jan 1
  dow: number; // row: 0 = Sunday .. 6 = Saturday
}

export interface HeatmapYear {
  year: number;
  weeks: number; // column count (52-54)
  months: { week: number; label: string }[]; // first-of-month positions
  days: HeatmapDay[];
}

const DAY_MS = 86_400_000;

/** A calendar day in the author's own timezone, matching the dates the
 *  commit list displays. */
export function commitDayKey(c: RepoCommit): string {
  return identLocalDate(c.author).toISOString().slice(0, 10);
}

/** Every day of `year` laid out GitHub-style: weeks are columns, days rows. */
export function yearGrid(year: number): HeatmapYear {
  const startDow = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  const end = Date.UTC(year, 11, 31);
  const days: HeatmapDay[] = [];
  const months: { week: number; label: string }[] = [];
  let i = 0;
  // UTC day arithmetic — every step is exactly 24h, no DST anywhere.
  for (let t = Date.UTC(year, 0, 1); t <= end; t += DAY_MS, i++) {
    const d = new Date(t);
    const week = Math.floor((startDow + i) / 7);
    if (d.getUTCDate() === 1) months.push({ week, label: MONTHS[d.getUTCMonth()] });
    days.push({ key: d.toISOString().slice(0, 10), week, dow: d.getUTCDay() });
  }
  return { year, weeks: Math.floor((startDow + i - 1) / 7) + 1, months, days };
}

/** The years that have any commits, ascending — gap years (bad clocks put
 *  strays decades out) get no row at all. */
export function commitYears(commits: RepoCommit[]): number[] {
  const years = new Set(commits.map((c) => identLocalDate(c.author).getUTCFullYear()));
  return [...years].sort((a, b) => a - b);
}

export function dayCounts(commits: RepoCommit[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of commits) {
    const k = commitDayKey(c);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/** Quartile breakpoints over the active (nonzero) days, so each color level
 *  covers about a quarter of them and one huge import day doesn't flatten
 *  the rest of the history to the palest step. */
export function levelThresholds(counts: Map<string, number>): number[] {
  const active = [...counts.values()].sort((a, b) => a - b);
  if (!active.length) return [];
  const q = (p: number) => active[Math.floor(p * (active.length - 1))];
  return [q(0.25), q(0.5), q(0.75)];
}

/** 0 = no commits; 1-4 = which quartile bucket the day's count lands in. */
export function levelFor(count: number, thresholds: number[]): number {
  if (count === 0) return 0;
  let level = 1;
  for (const t of thresholds) if (count > t) level++;
  return level;
}
