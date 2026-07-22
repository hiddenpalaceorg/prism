/** Thin pg helpers. Every cube function takes the pool/client as an argument
 * (host convention); cube never owns a pool. */

import type { Pool, PoolClient } from "pg";

export type Queryable = Pool | PoolClient;

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection-level failure; release handles it
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface PageRow {
  id: number;
  ns: string;
  slug: string;
  title: string;
  display_title: string | null;
  path: string | null;
  current_rev_id: number | null;
  is_redirect: boolean;
  protection: Record<string, string>;
  visibility: "public" | "moderator";
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RevisionRow {
  id: number;
  page_id: number;
  parent_rev_id: number | null;
  author_id: number | null;
  author_name: string;
  comment: string;
  minor: boolean;
  content: string;
  content_sha256: string;
  wikitext_fallback: boolean;
  mw_rev_id: number | null;
  created_at: Date;
}
