// ffmpeg-backed transcoding: MPEG-1/2 program streams (.mpg, DVD .vob) and
// bare MPEG video elementary streams to H.264/AAC MP4, the one video format
// every browser plays. Like Ghostscript in gs.ts, ffmpeg is a soft dependency:
// feature-detected at runtime, and callers degrade (download-only viewer)
// when it's missing.
//
// Unlike the PNG conversions, a transcode is too slow to redo per request, so
// results are cached in the blob store under .transcode/ (which can't collide
// with the two-hex-char blob dirs) and streamed from disk with Range support.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { assetBlobPath, assetStoreDir } from "./assets";

const execFileP = promisify(execFile);

const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";

// Inputs are capped by the analyzer (viewable.py MAX_ASSET_SIZE, 20MB), so a
// transcode is bounded work, but MPEG-2 decode plus x264 on a modest server
// can still take tens of seconds. Kill anything that runs away.
const FFMPEG_TIMEOUT_MS = 120_000;

/** Mimes ensureMp4 can transcode. */
export function mp4Transcodable(mime: string): boolean {
  return mime === "video/mpeg";
}

// Feature detection, memoized for the process lifetime.
let available: Promise<boolean> | null = null;

export function ffmpegAvailable(): Promise<boolean> {
  available ??= execFileP(FFMPEG_BIN, ["-version"], { timeout: 5_000 })
    .then(({ stdout }) => /^ffmpeg version/i.test(stdout))
    .catch(() => false);
  return available;
}

/** Where a blob's cached MP4 transcode lives. Caller must have validated `sha256`. */
export function transcodePath(sha256: string): string {
  return join(assetStoreDir(), ".transcode", `${sha256}.mp4`);
}

// One transcode per blob at a time: a gallery of players can fire several
// requests for the same asset before the first transcode finishes.
const inFlight = new Map<string, Promise<string>>();

/**
 * Path of the cached MP4 transcode for this blob, producing it on first use.
 * Throws when ffmpeg is missing, errors on the input, or times out.
 */
export async function ensureMp4(sha256: string): Promise<string> {
  const out = transcodePath(sha256);
  try {
    if ((await stat(out)).size > 0) return out;
  } catch {
    // Not cached yet.
  }
  let job = inFlight.get(sha256);
  if (!job) {
    job = transcode(sha256, out).finally(() => inFlight.delete(sha256));
    inFlight.set(sha256, job);
  }
  return job;
}

async function transcode(sha256: string, out: string): Promise<string> {
  if (!(await ffmpegAvailable())) throw new Error("ffmpeg not available");
  await mkdir(dirname(out), { recursive: true });
  // Private temp name in the final dir, atomically renamed on success, so a
  // concurrent request in another process never streams a partial file.
  const tmp = `${out}.${randomBytes(4).toString("hex")}.part`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    assetBlobPath(sha256),
    // First video + first audio track only: DVD VOBs carry alternate audio
    // tracks and subpicture/nav streams a browser player has no UI for.
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-dn",
    "-sn",
    // Deinterlace frames flagged interlaced (DVD content usually is), and
    // keep dimensions even (4:2:0 H.264 rejects odd sizes).
    "-vf",
    "yadif=deint=interlaced,scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    // moov atom up front so playback starts before the download completes.
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    tmp,
  ];
  try {
    await execFileP(FFMPEG_BIN, args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4_000_000 });
    if ((await stat(tmp)).size === 0) throw new Error("empty transcode");
    await rename(tmp, out);
    return out;
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
