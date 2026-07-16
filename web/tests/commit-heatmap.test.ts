import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commitDayKey,
  commitYears,
  dayCounts,
  levelFor,
  levelThresholds,
  yearGrid,
} from "../src/lib/commit-heatmap";
import type { RepoCommit, RepoIdent } from "../src/lib/repo-manifest";

function commitAt(time: number, tz = 0): RepoCommit {
  const ident: RepoIdent = { name: "a", email: "a@b", time, tz };
  return { oid: "0".repeat(40), tree: "1".repeat(40), parents: [], author: ident, committer: ident, message: "m" };
}

test("yearGrid lays out a leap year starting Monday", () => {
  const g = yearGrid(1996); // Jan 1 1996 was a Monday
  assert.equal(g.days.length, 366);
  assert.equal(g.weeks, 53);
  assert.deepEqual(g.days[0], { key: "1996-01-01", week: 0, dow: 1 });
  assert.deepEqual(g.days.at(-1), { key: "1996-12-31", week: 52, dow: 2 });
  assert.equal(g.months.length, 12);
  assert.deepEqual(g.months[0], { week: 0, label: "Jan" });
});

test("yearGrid handles the 54-column case", () => {
  const g = yearGrid(2000); // leap year starting Saturday
  assert.equal(g.weeks, 54);
  assert.deepEqual(g.days[0], { key: "2000-01-01", week: 0, dow: 6 });
  assert.deepEqual(g.days.at(-1), { key: "2000-12-31", week: 53, dow: 0 });
});

test("commitDayKey uses the author's own timezone", () => {
  // 1996-01-01 00:30 UTC, author at UTC-1 (JS convention: tz = +60)
  const utc = Date.UTC(1996, 0, 1, 0, 30) / 1000;
  assert.equal(commitDayKey(commitAt(utc, 60)), "1995-12-31");
  assert.equal(commitDayKey(commitAt(utc, -120)), "1996-01-01"); // UTC+2
});

test("commitYears is ascending and skips gap years", () => {
  const commits = [commitAt(Date.UTC(1998, 5, 1) / 1000), commitAt(Date.UTC(1994, 5, 1) / 1000)];
  assert.deepEqual(commitYears(commits), [1994, 1998]);
});

test("levels bucket active days into quartiles", () => {
  const commits = [1, 1, 2, 2, 3, 3, 5, 5].flatMap((n, day) =>
    Array.from({ length: n }, () => commitAt(Date.UTC(1996, 0, day + 1) / 1000))
  );
  const counts = dayCounts(commits);
  const t = levelThresholds(counts);
  assert.deepEqual(t, [1, 2, 3]);
  assert.equal(levelFor(0, t), 0);
  assert.equal(levelFor(1, t), 1);
  assert.equal(levelFor(2, t), 2);
  assert.equal(levelFor(3, t), 3);
  assert.equal(levelFor(5, t), 4);
});

test("levelThresholds of nothing is empty and level 1 still applies", () => {
  const t = levelThresholds(new Map());
  assert.deepEqual(t, []);
  assert.equal(levelFor(0, t), 0);
});
