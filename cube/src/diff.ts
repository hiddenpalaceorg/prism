/** Revision diffs: line-level change list (the editor renders word-level
 * refinement client-side from the same data). */

import { diffLines, type Change } from "diff";
import type { Pool } from "pg";

export interface RevisionDiff {
  from: { id: number; author: string; createdAt: Date };
  to: { id: number; author: string; createdAt: Date };
  samePage: boolean;
  changes: Change[];
}

export async function diffRevisions(pool: Pool, fromId: number, toId: number): Promise<RevisionDiff | null> {
  const res = await pool.query(
    `SELECT id, page_id, author_name, content, created_at FROM cube_revision WHERE id = ANY($1)`,
    [[fromId, toId]],
  );
  // node-pg returns BIGINT as strings; compare numerically.
  const from = res.rows.find((r) => Number(r.id) === fromId);
  const to = res.rows.find((r) => Number(r.id) === toId);
  if (!from || !to) return null;
  return {
    from: { id: Number(from.id), author: from.author_name, createdAt: from.created_at },
    to: { id: Number(to.id), author: to.author_name, createdAt: to.created_at },
    samePage: Number(from.page_id) === Number(to.page_id),
    changes: diffLines(from.content, to.content),
  };
}
