// Chunked upload sessions for magazine source PDFs — the build-media session
// pattern (media.ts) with a mag-pdf shape: two files under .staging/, no DB
// row until the bytes are complete, replayable finalize, per-token in-process
// lock. Sessions are moderator-created; the corpus tops out around 600MB per
// issue, so the cap leaves headroom without inviting abuse.

import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { assetStoreDir } from "../blobstore";

export const PDF_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const PDF_MAX_CHUNK = 32 * 1024 * 1024;

const SESSION_TTL_MS = 24 * 3600_000;

export interface MagPdfSession {
  issue: number;
  size: number;
  author: string;
  /** Set once the blob is stored and the issue row updated; kept so a client
   *  that never saw the reply gets the same answer instead of a 404. */
  done?: { sha256: string };
}

export function isMagToken(v: string): boolean {
  return /^[0-9a-f]{32}$/.test(v);
}

export function newMagToken(): string {
  return randomBytes(16).toString("hex");
}

export function magStagingPath(token: string): string {
  return path.join(assetStoreDir(), ".staging", `magpdf-${token}.part`);
}

function magSessionPath(token: string): string {
  return path.join(assetStoreDir(), ".staging", `magpdf-${token}.json`);
}

export async function createMagSession(token: string, session: MagPdfSession): Promise<void> {
  const dir = path.join(assetStoreDir(), ".staging");
  await fsp.mkdir(dir, { recursive: true });
  await reapStaleMagSessions(dir).catch(() => {});
  await updateMagSession(token, session);
  await fsp.writeFile(magStagingPath(token), Buffer.alloc(0));
}

export async function readMagSession(token: string): Promise<MagPdfSession | null> {
  try {
    return JSON.parse(await fsp.readFile(magSessionPath(token), "utf8")) as MagPdfSession;
  } catch {
    return null;
  }
}

/** Temp-write + rename like updateMediaSession: a crash mid-write must leave
 *  the previous sidecar, not truncated JSON. */
export async function updateMagSession(token: string, session: MagPdfSession): Promise<void> {
  const dest = magSessionPath(token);
  const tmp = `${dest}.tmp${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(session));
  await fsp.rename(tmp, dest);
}

export async function dropMagSession(token: string): Promise<void> {
  await fsp.rm(magSessionPath(token), { force: true });
  await fsp.rm(magStagingPath(token), { force: true });
}

/** Retire a finished session: payload gone, sidecar kept with the answer. */
export async function finishMagSession(token: string, session: MagPdfSession, sha256: string): Promise<void> {
  await updateMagSession(token, { ...session, done: { sha256 } });
  await fsp.rm(magStagingPath(token), { force: true });
}

async function reapStaleMagSessions(dir: string): Promise<void> {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const name of await fsp.readdir(dir)) {
    if (!name.startsWith("magpdf-")) continue;
    const p = path.join(dir, name);
    try {
      if ((await fsp.stat(p)).mtimeMs < cutoff) await fsp.rm(p, { force: true });
    } catch {
      // Raced with another reaper or an active finalize; leave it.
    }
  }
}
