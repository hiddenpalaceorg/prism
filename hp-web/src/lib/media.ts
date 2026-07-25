// Community metadata: user-uploaded media (screenshots, videos, physical
// media photos), plain-text notes, and per-build completeness skip flags.
// Media bytes live in the blob store under the media/ namespace,
// content-addressed like assets, but a separate part of the bucket so asset
// tooling can never touch user uploads. Uploads arrive in chunks (staged
// under .staging/ next to the asset staging) because the production app sits
// behind a proxy with a per-request body limit.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { assetStoreDir } from "./blobstore";

/** Store namespace for user media (see blobstore key layout). */
export const MEDIA_NS = "media/";

export const MEDIA_KINDS = ["screenshot", "video", "physical"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export function isMediaKind(v: unknown): v is MediaKind {
  return typeof v === "string" && (MEDIA_KINDS as readonly string[]).includes(v);
}

/** What a physical-media photo shows. NULL in the DB (pre-label uploads)
 *  reads as "other". The OG card prefers the first 'front' photo. */
export const MEDIA_LABELS = ["front", "back", "other"] as const;
export type MediaLabel = (typeof MEDIA_LABELS)[number];

export function isMediaLabel(v: unknown): v is MediaLabel {
  return typeof v === "string" && (MEDIA_LABELS as readonly string[]).includes(v);
}

/** Guess a physical photo's label from its filename — uploads arrive named
 *  "… Front.png" / "… Back.png" far more often than anyone touches the label
 *  selector afterward. An explicit label always wins over this. */
export function inferMediaLabel(filename: string): MediaLabel {
  if (/(^|[^a-z])front([^a-z]|$)/i.test(filename)) return "front";
  if (/(^|[^a-z])back([^a-z]|$)/i.test(filename)) return "back";
  return "other";
}

/** Upload size caps. Images stay modest; videos get room for real captures. */
export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 512 * 1024 * 1024;

export function kindMaxBytes(kind: MediaKind): number {
  return kind === "video" ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
}

/** Longest accepted original filename (display only; bytes are content-addressed). */
export const MAX_FILENAME_LEN = 200;

/** Note body cap (plain text). */
export const MAX_NOTE_LEN = 10_000;

/** Sniff the accepted media container formats from a file's leading bytes.
 *  The stored content_type is always this verdict, never the client's claim.
 *  Returns null for everything else (SVG stays out on purpose, it can script). */
export function sniffMedia(head: Buffer): { contentType: string; video: boolean } | null {
  if (head.length >= 12) {
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
      return { contentType: "image/png", video: false };
    }
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      return { contentType: "image/jpeg", video: false };
    }
    if (head.toString("latin1", 0, 4) === "GIF8") {
      return { contentType: "image/gif", video: false };
    }
    if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") {
      return { contentType: "image/webp", video: false };
    }
    if (head.toString("latin1", 4, 8) === "ftyp") {
      return { contentType: "video/mp4", video: true };
    }
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
      // Matroska EBML, served as WebM (browsers demux both).
      return { contentType: "video/webm", video: true };
    }
  }
  return null;
}

/** Public URL for one media blob: the bucket gateway when configured (same
 *  contract as publicAssetUrl, keys under media/), else the app route. */
export function mediaUrl(sha256: string, contentType: string): string {
  const base = process.env.ASSET_PUBLIC_BASE;
  if (base && /^(image|video)\/[\w.+-]+$/.test(contentType) && contentType !== "image/svg+xml") {
    return `${base.replace(/\/+$/, "")}/media/${sha256.slice(0, 2)}/${sha256}`;
  }
  return `/api/media/${sha256}`;
}

// ── chunked upload sessions ──────────────────────────────────────────────────
// A session is two files under the store's .staging dir: the growing payload
// and a JSON sidecar with what finalize needs. No DB row until the bytes are
// complete and sniffed, so abandoned uploads leave nothing behind but staging
// files (reaped after a day).

export interface MediaSession {
  build: string;
  kind: MediaKind;
  filename: string;
  size: number;
  author: string;
  /** Physical photos only. */
  label?: MediaLabel;
  /** Sniffed at the first chunk; absent until then. */
  contentType?: string;
}

const SESSION_TTL_MS = 24 * 3600_000;

export function isMediaToken(v: string): boolean {
  return /^[0-9a-f]{32}$/.test(v);
}

export function newMediaToken(): string {
  return randomBytes(16).toString("hex");
}

export function mediaStagingPath(token: string): string {
  return path.join(assetStoreDir(), ".staging", `media-${token}.part`);
}

function mediaSessionPath(token: string): string {
  return path.join(assetStoreDir(), ".staging", `media-${token}.json`);
}

export async function createMediaSession(token: string, session: MediaSession): Promise<void> {
  const dir = path.join(assetStoreDir(), ".staging");
  await fsp.mkdir(dir, { recursive: true });
  await reapStaleSessions(dir).catch(() => {});
  await fsp.writeFile(mediaSessionPath(token), JSON.stringify(session));
  await fsp.writeFile(mediaStagingPath(token), Buffer.alloc(0));
}

export async function readMediaSession(token: string): Promise<MediaSession | null> {
  try {
    return JSON.parse(await fsp.readFile(mediaSessionPath(token), "utf8")) as MediaSession;
  } catch {
    return null;
  }
}

export async function updateMediaSession(token: string, session: MediaSession): Promise<void> {
  await fsp.writeFile(mediaSessionPath(token), JSON.stringify(session));
}

export async function dropMediaSession(token: string): Promise<void> {
  await fsp.rm(mediaSessionPath(token), { force: true });
  await fsp.rm(mediaStagingPath(token), { force: true });
}

async function reapStaleSessions(dir: string): Promise<void> {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const name of await fsp.readdir(dir)) {
    if (!name.startsWith("media-")) continue;
    const p = path.join(dir, name);
    try {
      if ((await fsp.stat(p)).mtimeMs < cutoff) await fsp.rm(p, { force: true });
    } catch {
      // Raced with another reaper or an active finalize; leave it.
    }
  }
}

/** Streaming sha256 of a staged file. */
export function hashFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    fs.createReadStream(p)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

// ── rows ─────────────────────────────────────────────────────────────────────

export interface BuildMediaRow {
  id: number;
  build_sha256: string;
  kind: MediaKind;
  sha256: string;
  poster_sha256: string | null;
  filename: string;
  content_type: string;
  size: number;
  author: string;
  /** Physical photos only; NULL rows predate labels and read as "other". */
  label: MediaLabel | null;
  created_at: string;
}

/** A media row plus its serving URLs, as the media APIs and pages hand out. */
export interface BuildMediaView extends BuildMediaRow {
  url: string;
  posterUrl: string | null;
}

export function mediaView(m: BuildMediaRow): BuildMediaView {
  return {
    ...m,
    url: mediaUrl(m.sha256, m.content_type),
    posterUrl: m.poster_sha256 ? mediaUrl(m.poster_sha256, "image/jpeg") : null,
  };
}

export interface BuildNoteRow {
  id: number;
  build_sha256: string;
  body: string;
  author: string;
  created_at: string;
  edited_at: string | null;
}

export interface SkipFlags {
  skip_notes: boolean;
  skip_screenshots: boolean;
  skip_video: boolean;
  skip_physical: boolean;
}

export const NO_SKIPS: SkipFlags = {
  skip_notes: false,
  skip_screenshots: false,
  skip_video: false,
  skip_physical: false,
};

const MEDIA_COLS =
  "id::int AS id, build_sha256, kind, sha256, poster_sha256, filename, content_type, size::float8 AS size, author, label, created_at::text AS created_at";

const NOTE_COLS = "id::int AS id, build_sha256, body, author, created_at::text AS created_at, edited_at::text AS edited_at";

export async function getBuildMedia(pool: Pool, buildSha: string): Promise<BuildMediaRow[]> {
  const r = await pool.query(
    `SELECT ${MEDIA_COLS} FROM build_media WHERE build_sha256=$1 ORDER BY created_at, id`,
    [buildSha]
  );
  return r.rows as BuildMediaRow[];
}

export async function getMediaById(pool: Pool, buildSha: string, id: number): Promise<BuildMediaRow | null> {
  const r = await pool.query(`SELECT ${MEDIA_COLS} FROM build_media WHERE build_sha256=$1 AND id=$2`, [
    buildSha,
    id,
  ]);
  return (r.rows[0] as BuildMediaRow) ?? null;
}

/** Insert one media row; on a duplicate (same build, kind, file) returns the
 *  existing row instead. */
export async function insertMedia(
  pool: Pool,
  m: {
    build_sha256: string;
    kind: MediaKind;
    sha256: string;
    poster_sha256: string | null;
    filename: string;
    content_type: string;
    size: number;
    author: string;
    label: MediaLabel | null;
  }
): Promise<BuildMediaRow> {
  const r = await pool.query(
    `INSERT INTO build_media (build_sha256, kind, sha256, poster_sha256, filename, content_type, size, author, label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (build_sha256, kind, sha256) DO NOTHING
     RETURNING ${MEDIA_COLS}`,
    [m.build_sha256, m.kind, m.sha256, m.poster_sha256, m.filename, m.content_type, m.size, m.author, m.label]
  );
  if (r.rows[0]) return r.rows[0] as BuildMediaRow;
  const existing = await pool.query(
    `SELECT ${MEDIA_COLS} FROM build_media WHERE build_sha256=$1 AND kind=$2 AND sha256=$3`,
    [m.build_sha256, m.kind, m.sha256]
  );
  return existing.rows[0] as BuildMediaRow;
}

/** Relabel one physical photo; returns the updated row, or null when the id
 *  is missing or not a physical photo. */
export async function updateMediaLabel(
  pool: Pool,
  buildSha: string,
  id: number,
  label: MediaLabel
): Promise<BuildMediaRow | null> {
  const r = await pool.query(
    `UPDATE build_media SET label=$3 WHERE build_sha256=$1 AND id=$2 AND kind='physical' RETURNING ${MEDIA_COLS}`,
    [buildSha, id, label]
  );
  return (r.rows[0] as BuildMediaRow) ?? null;
}

export async function deleteMedia(pool: Pool, buildSha: string, id: number): Promise<boolean> {
  const r = await pool.query("DELETE FROM build_media WHERE build_sha256=$1 AND id=$2", [buildSha, id]);
  return !!r.rowCount;
}

/** Look up the served content type of a media blob (or a video's poster). */
export async function mediaContentType(pool: Pool, sha256: string): Promise<string | null> {
  const r = await pool.query(
    `SELECT content_type FROM build_media WHERE sha256=$1
     UNION ALL
     SELECT 'image/jpeg' FROM build_media WHERE poster_sha256=$1
     LIMIT 1`,
    [sha256]
  );
  return (r.rows[0]?.content_type as string) ?? null;
}

export async function getBuildNotes(pool: Pool, buildSha: string): Promise<BuildNoteRow[]> {
  const r = await pool.query(
    `SELECT ${NOTE_COLS} FROM build_note WHERE build_sha256=$1 ORDER BY created_at, id`,
    [buildSha]
  );
  return r.rows as BuildNoteRow[];
}

export async function getNoteById(pool: Pool, buildSha: string, id: number): Promise<BuildNoteRow | null> {
  const r = await pool.query(`SELECT ${NOTE_COLS} FROM build_note WHERE build_sha256=$1 AND id=$2`, [
    buildSha,
    id,
  ]);
  return (r.rows[0] as BuildNoteRow) ?? null;
}

export async function insertNote(pool: Pool, buildSha: string, body: string, author: string): Promise<BuildNoteRow> {
  const r = await pool.query(
    `INSERT INTO build_note (build_sha256, body, author) VALUES ($1,$2,$3) RETURNING ${NOTE_COLS}`,
    [buildSha, body, author]
  );
  return r.rows[0] as BuildNoteRow;
}

export async function updateNote(pool: Pool, buildSha: string, id: number, body: string): Promise<BuildNoteRow | null> {
  const r = await pool.query(
    `UPDATE build_note SET body=$3, edited_at=now() WHERE build_sha256=$1 AND id=$2 RETURNING ${NOTE_COLS}`,
    [buildSha, id, body]
  );
  return (r.rows[0] as BuildNoteRow) ?? null;
}

export async function deleteNote(pool: Pool, buildSha: string, id: number): Promise<boolean> {
  const r = await pool.query("DELETE FROM build_note WHERE build_sha256=$1 AND id=$2", [buildSha, id]);
  return !!r.rowCount;
}

export async function getBuildSkip(pool: Pool, buildSha: string): Promise<SkipFlags> {
  const r = await pool.query(
    "SELECT skip_notes, skip_screenshots, skip_video, skip_physical FROM build_skip WHERE build_sha256=$1",
    [buildSha]
  );
  return (r.rows[0] as SkipFlags) ?? NO_SKIPS;
}

/** Upsert the skip flags; omitted fields keep their stored value. */
export async function upsertSkip(pool: Pool, buildSha: string, flags: Partial<SkipFlags>): Promise<SkipFlags> {
  const r = await pool.query(
    `INSERT INTO build_skip (build_sha256, skip_notes, skip_screenshots, skip_video, skip_physical)
     VALUES ($1, COALESCE($2, FALSE), COALESCE($3, FALSE), COALESCE($4, FALSE), COALESCE($5, FALSE))
     ON CONFLICT (build_sha256) DO UPDATE SET
       skip_notes       = COALESCE($2, build_skip.skip_notes),
       skip_screenshots = COALESCE($3, build_skip.skip_screenshots),
       skip_video       = COALESCE($4, build_skip.skip_video),
       skip_physical    = COALESCE($5, build_skip.skip_physical)
     RETURNING skip_notes, skip_screenshots, skip_video, skip_physical`,
    [
      buildSha,
      flags.skip_notes ?? null,
      flags.skip_screenshots ?? null,
      flags.skip_video ?? null,
      flags.skip_physical ?? null,
    ]
  );
  return r.rows[0] as SkipFlags;
}
