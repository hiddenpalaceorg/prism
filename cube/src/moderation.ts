/**
 * Moderation tools: page protection, visibility, user
 * blocking, mass revert, and the RecentChanges feed. Every action is logged
 * to cube_page_log; mass revert goes through the normal save pipeline and
 * never rewrites history.
 */

import type { Pool } from "pg";
import { canonicalUsername } from "./auth/native";
import { withTx } from "./db";
import { deletePage, savePage, type CubeAuthor, type SaveContext } from "./save";

export class CubeModerationError extends Error {
  constructor(
    readonly code: "not_found" | "bad_request",
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CubeModerationError";
  }
}

type PageRefInput = {
  ns: string;
  slug: string;
  actor: CubeAuthor;
};

/** Set cube_page.protection (empty object = unprotect); logged as "protect". */
export async function protectPage(
  pool: Pool,
  input: PageRefInput & { protection: Record<string, string> },
): Promise<void> {
  await withTx(pool, async (client) => {
    const res = await client.query(
      `UPDATE cube_page SET protection = $3, updated_at = now()
        WHERE ns = $1 AND slug = $2 AND deleted_at IS NULL
        RETURNING id`,
      [input.ns, input.slug, JSON.stringify(input.protection)],
    );
    if (res.rows[0] === undefined) {
      throw new CubeModerationError("not_found", 404, "no such page");
    }
    await client.query(
      `INSERT INTO cube_page_log (page_id, action, actor_id, actor_name, detail)
       VALUES ($1, 'protect', $2, $3, $4)`,
      [
        Number(res.rows[0].id),
        input.actor.id ?? null,
        input.actor.name,
        JSON.stringify({ protection: input.protection }),
      ],
    );
  });
}

export async function setPageVisibility(
  pool: Pool,
  input: PageRefInput & { visibility: "public" | "moderator" },
): Promise<void> {
  if (input.visibility !== "public" && input.visibility !== "moderator") {
    throw new CubeModerationError("bad_request", 400, "visibility must be public or moderator");
  }
  await withTx(pool, async (client) => {
    const res = await client.query(
      `UPDATE cube_page SET visibility = $3, updated_at = now()
        WHERE ns = $1 AND slug = $2 AND deleted_at IS NULL
        RETURNING id`,
      [input.ns, input.slug, input.visibility],
    );
    if (res.rows[0] === undefined) {
      throw new CubeModerationError("not_found", 404, "no such page");
    }
    await client.query(
      `INSERT INTO cube_page_log (page_id, action, actor_id, actor_name, detail)
       VALUES ($1, 'visibility', $2, $3, $4)`,
      [
        Number(res.rows[0].id),
        input.actor.id ?? null,
        input.actor.name,
        JSON.stringify({ visibility: input.visibility }),
      ],
    );
  });
}

/** Block a user: can() denies all writes, and their live sessions are killed. */
export async function blockUser(
  pool: Pool,
  input: { name: string; reason?: string; actor: CubeAuthor },
): Promise<void> {
  const name = canonicalUsername(input.name);
  await withTx(pool, async (client) => {
    const res = await client.query(
      `UPDATE cube_user SET blocked_at = now(), blocked_by = $2, block_reason = $3
        WHERE name = $1 RETURNING id`,
      [name, input.actor.id ?? null, input.reason ?? null],
    );
    if (res.rows[0] === undefined) {
      throw new CubeModerationError("not_found", 404, `no such user: ${name}`);
    }
    await client.query(`DELETE FROM cube_session WHERE user_id = $1`, [Number(res.rows[0].id)]);
    await client.query(
      `INSERT INTO cube_page_log (page_id, action, actor_id, actor_name, detail)
       VALUES (NULL, 'block', $1, $2, $3)`,
      [input.actor.id ?? null, input.actor.name, JSON.stringify({ name, reason: input.reason ?? "" })],
    );
  });
}

export async function unblockUser(
  pool: Pool,
  input: { name: string; actor: CubeAuthor },
): Promise<void> {
  const name = canonicalUsername(input.name);
  await withTx(pool, async (client) => {
    const res = await client.query(
      `UPDATE cube_user SET blocked_at = NULL, blocked_by = NULL, block_reason = NULL
        WHERE name = $1 RETURNING id`,
      [name],
    );
    if (res.rows[0] === undefined) {
      throw new CubeModerationError("not_found", 404, `no such user: ${name}`);
    }
    await client.query(
      `INSERT INTO cube_page_log (page_id, action, actor_id, actor_name, detail)
       VALUES (NULL, 'unblock', $1, $2, $3)`,
      [input.actor.id ?? null, input.actor.name, JSON.stringify({ name })],
    );
  });
}

export type MassRevertInput = {
  userName: string;
  since: Date;
  actor: CubeAuthor;
  comment?: string;
};

export type MassRevertResult = {
  reverted: number;
  deleted: number;
  skipped: { slug: string; reason: string }[];
};

/**
 * Revert every page whose current revision is by userName since a cutoff:
 * save the newest revision by anyone else as a new revision under the
 * actor's name (normal save pipeline, history intact); pages the user
 * created outright (no other-author revision) are soft-deleted.
 */
export async function massRevert(
  pool: Pool,
  ctx: SaveContext,
  input: MassRevertInput,
): Promise<MassRevertResult> {
  const name = canonicalUsername(input.userName);
  const comment = input.comment ?? `mass revert of ${name}`;
  const pages = await pool.query(
    `SELECT p.id, p.ns, p.slug, r.id AS rev_id
       FROM cube_page p
       JOIN cube_revision r ON r.id = p.current_rev_id
      WHERE p.deleted_at IS NULL AND r.author_name = $1 AND r.created_at >= $2
      ORDER BY p.id`,
    [name, input.since],
  );

  const result: MassRevertResult = { reverted: 0, deleted: 0, skipped: [] };
  for (const page of pages.rows) {
    const pageId = Number(page.id);
    const good = await pool.query(
      `SELECT id, content, wikitext_fallback
         FROM cube_revision
        WHERE page_id = $1 AND author_name <> $2
        ORDER BY id DESC
        LIMIT 1`,
      [pageId, name],
    );
    try {
      if (good.rows[0] === undefined) {
        await deletePage(pool, { ns: page.ns, slug: page.slug, actor: input.actor, reason: comment });
        result.deleted += 1;
      } else {
        await savePage(pool, ctx, {
          ns: page.ns,
          slug: page.slug,
          markdown: good.rows[0].content,
          baseRevId: Number(page.rev_id),
          author: input.actor,
          comment,
          wikitextFallback: good.rows[0].wikitext_fallback === true,
        });
        result.reverted += 1;
      }
    } catch (err) {
      result.skipped.push({
        slug: page.slug,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

export type RecentChange = {
  revId: number;
  ns: string;
  slug: string;
  title: string;
  author: string;
  comment: string;
  minor: boolean;
  wikitextFallback: boolean;
  createdAt: Date;
  bytes: number;
  /** Length delta vs the parent revision (new pages count from zero). */
  delta: number;
};

export async function listRecentChanges(
  pool: Pool,
  opts: { limit?: number; before?: number; user?: string } = {},
): Promise<RecentChange[]> {
  const limit = Math.min(opts.limit ?? 50, 500);
  const res = await pool.query(
    `SELECT r.id, p.ns, p.slug, p.title, r.author_name, r.comment, r.minor,
            r.wikitext_fallback, r.created_at,
            length(r.content) AS bytes,
            length(r.content) - COALESCE(length(pr.content), 0) AS delta
       FROM cube_revision r
       JOIN cube_page p ON p.id = r.page_id
       LEFT JOIN cube_revision pr ON pr.id = r.parent_rev_id
      WHERE p.deleted_at IS NULL AND p.visibility = 'public'
        AND ($1::text IS NULL OR r.author_name = $1)
        AND ($2::bigint IS NULL OR r.id < $2)
      ORDER BY r.id DESC
      LIMIT $3`,
    [opts.user ?? null, opts.before ?? null, limit],
  );
  return res.rows.map((r) => ({
    revId: Number(r.id),
    ns: r.ns,
    slug: r.slug,
    title: r.title,
    author: r.author_name,
    comment: r.comment,
    minor: r.minor,
    wikitextFallback: r.wikitext_fallback,
    createdAt: r.created_at,
    bytes: Number(r.bytes),
    delta: Number(r.delta),
  }));
}
