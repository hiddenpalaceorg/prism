// Line blame for the repo viewer, computed by replaying a file's history
// (the fileLog chain, oldest first): each version diffs against the previous,
// unchanged lines carry their blame forward, added lines take the version
// that introduced them. Pure — no React, no I/O — shared by the blame route
// and its tests; the hunk grouping is what the client renders.

import { diffLines } from "diff";
import { splitLines } from "./linediff";
import type { RepoIdent } from "./repo-manifest";

/** `versions` oldest→newest; result[i] = index into `versions` of the version
 *  that introduced line i of the newest version. */
export function blameLines(versions: string[]): number[] {
  let blame: number[] = [];
  let prev = "";
  versions.forEach((text, v) => {
    const next: number[] = [];
    let li = 0; // line index into prev / blame
    for (const part of diffLines(prev, text)) {
      const n = splitLines(part.value).length;
      if (part.removed) li += n;
      else if (part.added) for (let i = 0; i < n; i++) next.push(v);
      else for (let i = 0; i < n; i++) next.push(blame[li++]);
    }
    blame = next;
    prev = text;
  });
  return blame;
}

/** A run of consecutive lines blamed on the same commit — one gutter cell. */
export interface BlameHunk {
  commit: number; // index into BlameDto.commits
  start: number; // 0-based first line
  len: number;
}

export function blameHunks(lines: number[]): BlameHunk[] {
  const out: BlameHunk[] = [];
  for (let i = 0; i < lines.length; i++) {
    const last = out[out.length - 1];
    if (last && last.commit === lines[i]) last.len++;
    else out.push({ commit: lines[i], start: i, len: 1 });
  }
  return out;
}

/** What /api/repo/.../blame serves: per final line an index into `commits`
 *  (the file's history oldest→newest, subjects only — the log route has the
 *  full story). */
export interface BlameCommitDto {
  oid: string;
  author: RepoIdent;
  subject: string;
}

export interface BlameDto {
  rev: string;
  path: string;
  commits: BlameCommitDto[];
  lines: number[];
}
