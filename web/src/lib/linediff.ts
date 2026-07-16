// Side-by-side line diff for the repo viewer: jsdiff's Myers line diff paired
// into aligned left/right rows (deletions pair with insertions inside a change
// block, GitHub-style). Pure — no React, no I/O — so the pairing is testable.

import { diffLines } from "diff";

export interface DiffCell {
  n: number; // 1-based line number in its own version
  s: string;
}

export interface DiffRow {
  l: DiffCell | null; // null = line only exists on the right (insertion filler)
  r: DiffCell | null; // null = line only exists on the left (deletion filler)
  changed: boolean;
}

/** value ("a\nb\n") -> ["a","b"]; a trailing newline is not an extra line. */
function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Aligned side-by-side rows for two file versions. Change blocks pair the
 *  i-th removed line with the i-th added line; the longer side fills with
 *  nulls. Equal lines advance both sides. */
export function diffRows(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let ln = 1; // next line number, left
  let rn = 1; // next line number, right
  let pendingDel: DiffCell[] = [];

  const flush = (added: DiffCell[]) => {
    const n = Math.max(pendingDel.length, added.length);
    for (let i = 0; i < n; i++) {
      rows.push({ l: pendingDel[i] ?? null, r: added[i] ?? null, changed: true });
    }
    pendingDel = [];
  };

  for (const part of diffLines(before, after)) {
    const lines = splitLines(part.value);
    if (part.removed) {
      // Hold deletions until we see whether insertions follow (a change block).
      for (const s of lines) pendingDel.push({ n: ln++, s });
    } else if (part.added) {
      flush(lines.map((s) => ({ n: rn++, s })));
    } else {
      flush([]);
      for (const s of lines) {
        rows.push({ l: { n: ln++, s }, r: { n: rn++, s }, changed: false });
      }
    }
  }
  flush([]);
  return rows;
}

/** Row indices to show when collapsing context: every changed row plus
 *  `context` rows around it. Returned as sorted [start, end) spans of visible
 *  rows; gaps between spans render as expandable "N unchanged lines" bars. */
export function visibleSpans(rows: DiffRow[], context = 3): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].changed) continue;
    const start = Math.max(0, i - context);
    const end = Math.min(rows.length, i + context + 1);
    const last = spans[spans.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  }
  return spans;
}
