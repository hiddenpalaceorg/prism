/**
 * Live git export: a single serialized worker drains cube_git_queue into a
 * local repo, one commit per revision, then pushes. DB is the source of
 * truth; the mirror is derived and push failures never block saves.
 */

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Pool, PoolClient } from "pg";
import type { CubeAuthor } from "./save";

const exec = promisify(execFile);

export interface GitExportConfig {
  /** Working repo directory (created + `git init` on first run). */
  dir: string;
  remote?: string;
  branch?: string;
  /** Author identity for commits; default derives a noreply address. */
  author?: (a: CubeAuthor) => { name: string; email: string };
  emailDomain?: string;
}

const ADVISORY_LOCK_KEY = 42_001_001;

export interface DrainResult {
  processed: number;
  /** False when another worker holds the lock. */
  locked: boolean;
  pushError?: string;
  itemError?: { queueId: number; message: string };
}

interface QueueItem {
  id: number;
  action: "save" | "move" | "delete";
  detail: { ns?: string; slug?: string; title?: string; from?: { ns: string; slug: string }; to?: { ns: string; slug: string } };
  rev_id: number | null;
  content: string | null;
  wikitext_fallback: boolean | null;
  comment: string | null;
  author_name: string | null;
  created_at: Date | null;
}

export async function processGitQueue(
  pool: Pool,
  cfg: GitExportConfig,
  opts: { max?: number } = {},
): Promise<DrainResult> {
  const client = await pool.connect();
  try {
    const lock = await client.query(`SELECT pg_try_advisory_lock($1) AS ok`, [ADVISORY_LOCK_KEY]);
    if (!lock.rows[0].ok) return { processed: 0, locked: false };

    try {
      await ensureRepo(cfg);
      let processed = 0;
      const max = opts.max ?? 200;

      while (processed < max) {
        const batch = await client.query(
          `SELECT q.id, q.action, q.detail, q.rev_id,
                  r.content, r.wikitext_fallback, r.comment, r.author_name, r.created_at
             FROM cube_git_queue q
             LEFT JOIN cube_revision r ON r.id = q.rev_id
            WHERE q.done_at IS NULL
            ORDER BY q.id
            LIMIT $1`,
          [Math.min(50, max - processed)],
        );
        if (batch.rows.length === 0) break;

        for (const raw of batch.rows) {
          const item: QueueItem = { ...raw, id: Number(raw.id), rev_id: raw.rev_id === null ? null : Number(raw.rev_id) };
          try {
            await applyItem(cfg, item);
            await client.query(`UPDATE cube_git_queue SET done_at = now() WHERE id = $1`, [item.id]);
            processed++;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await client.query(
              `UPDATE cube_git_queue SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
              [item.id, message.slice(0, 2000)],
            );
            // Head-of-line blocking is deliberate: commits must stay ordered.
            return { processed, locked: true, itemError: { queueId: item.id, message } };
          }
        }
      }

      let pushError: string | undefined;
      if (cfg.remote && processed > 0) {
        try {
          await git(cfg.dir, ["push", cfg.remote, cfg.branch ?? "main"]);
        } catch (err) {
          pushError = err instanceof Error ? err.message : String(err);
        }
      }
      return { processed, locked: true, ...(pushError && { pushError }) };
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/** Long-running worker: LISTEN cube_git + poll. Returns a stop function. */
export function startGitWorker(
  pool: Pool,
  cfg: GitExportConfig,
  opts: { pollMs?: number; onError?: (err: unknown) => void } = {},
): () => Promise<void> {
  let stopped = false;
  let running = false;
  let listenClient: PoolClient | undefined;

  const kick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await processGitQueue(pool, cfg);
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
    }
  };

  void (async () => {
    try {
      listenClient = await pool.connect();
      await listenClient.query("LISTEN cube_git");
      (listenClient as unknown as { on: (ev: string, fn: () => void) => void }).on("notification", () => {
        void kick();
      });
    } catch (err) {
      opts.onError?.(err);
    }
  })();

  const interval = setInterval(() => void kick(), opts.pollMs ?? 30_000);
  void kick();

  return async () => {
    stopped = true;
    clearInterval(interval);
    listenClient?.release();
  };
}

/* ---- internals ----------------------------------------------------------- */

async function applyItem(cfg: GitExportConfig, item: QueueItem): Promise<void> {
  const branch = cfg.branch ?? "main";
  const env = commitEnv(cfg, item);

  if (item.action === "save") {
    if (item.rev_id === null || item.content === null) throw new Error(`save item ${item.id} has no revision`);
    const path = pageFile(item.detail.ns!, item.detail.slug!, item.wikitext_fallback ?? false);
    const abs = join(cfg.dir, path);
    await mkdir(dirname(abs), { recursive: true });
    // A converted page may replace an earlier wikitext fallback (or vice versa).
    const twin = pageFile(item.detail.ns!, item.detail.slug!, !(item.wikitext_fallback ?? false));
    if (existsSync(join(cfg.dir, twin))) {
      await git(cfg.dir, ["rm", "-q", "--", twin]);
    }
    await writeFile(abs, item.content, "utf8");
    await git(cfg.dir, ["add", "--", path]);
    await commit(cfg, env, item.comment || `Edit ${item.detail.title ?? item.detail.slug}`, [
      `Cube-Rev: ${item.rev_id}`,
      `Cube-Page: ${item.detail.ns}/${item.detail.slug}`,
    ]);
  } else if (item.action === "move") {
    const { from, to } = item.detail;
    if (!from || !to) throw new Error(`move item ${item.id} missing detail`);
    for (const fallback of [false, true]) {
      const src = pageFile(from.ns, from.slug, fallback);
      if (existsSync(join(cfg.dir, src))) {
        const dst = pageFile(to.ns, to.slug, fallback);
        await mkdir(dirname(join(cfg.dir, dst)), { recursive: true });
        await git(cfg.dir, ["mv", "--", src, dst]);
      }
    }
    await commit(cfg, env, `Move ${from.ns}/${from.slug} to ${to.ns}/${to.slug}`, [
      `Cube-Page: ${to.ns}/${to.slug}`,
    ]);
  } else if (item.action === "delete") {
    const { ns, slug } = item.detail;
    let removed = false;
    for (const fallback of [false, true]) {
      const path = pageFile(ns!, slug!, fallback);
      if (existsSync(join(cfg.dir, path))) {
        await git(cfg.dir, ["rm", "-q", "--", path]);
        removed = true;
      }
    }
    if (removed) {
      await commit(cfg, env, `Delete ${ns}/${slug}`, [`Cube-Page: ${ns}/${slug}`]);
    }
  } else {
    throw new Error(`unknown git queue action: ${item.action as string}`);
  }
  void branch;
}

function commitEnv(cfg: GitExportConfig, item: QueueItem): NodeJS.ProcessEnv {
  const name = item.author_name ?? "cube";
  const identity = cfg.author
    ? cfg.author({ name })
    : { name, email: `${slugifyEmail(name)}@${cfg.emailDomain ?? "cube.invalid"}` };
  const date = (item.created_at ?? new Date()).toISOString();
  return {
    ...process.env,
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_COMMITTER_DATE: date,
  };
}

function slugifyEmail(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9._-]+/g, ".").replace(/^\.+|\.+$/g, "");
  return cleaned || "anon";
}

async function commit(cfg: GitExportConfig, env: NodeJS.ProcessEnv, message: string, trailers: string[]): Promise<void> {
  const full = `${message.trim()}\n\n${trailers.join("\n")}\n`;
  await git(cfg.dir, ["commit", "-q", "--allow-empty", "-m", full], env);
}

async function ensureRepo(cfg: GitExportConfig): Promise<void> {
  await mkdir(cfg.dir, { recursive: true });
  if (!existsSync(join(cfg.dir, ".git"))) {
    await git(cfg.dir, ["init", "-q", "-b", cfg.branch ?? "main"]);
  }
}

async function git(dir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: dir, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * Filesystem path for a page: {ns}/{slug}.md with per-segment encoding of
 * characters that are unsafe on disk. Subpage slashes become directories.
 * Case-only collisions get a stable suffix upstream (importer concern).
 */
export function pageFile(ns: string, slug: string, wikitextFallback: boolean): string {
  const segments = slug.split("/").map(encodeSegment);
  return `${ns}/${segments.join("/")}${wikitextFallback ? ".wiki" : ".md"}`;
}

function encodeSegment(seg: string): string {
  let out = seg.replace(/[%\\:*?"<>|\u0000-\u001F\u007F]/g, (ch) => {
    return "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
  });
  if (out.startsWith(".")) out = "%2E" + out.slice(1);
  if (out === "") out = "%20";
  return out;
}

/** Test helper: wipe a repo dir (used by integration tests only). */
export async function removeRepo(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
