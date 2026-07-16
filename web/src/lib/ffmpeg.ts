// ffmpeg-backed transcoding: MPEG-1/2 program streams (.mpg, DVD .vob) and
// bare MPEG video elementary streams to a format browsers actually play.
// Like Ghostscript in gs.ts, ffmpeg is a soft dependency: feature-detected at
// runtime, and callers degrade (download-only viewer) when it's missing.
//
// The output format follows what the ffmpeg build can encode: H.264/AAC MP4
// (universal) when libx264 is present, else VP9/Opus WebM (all modern
// browsers) for the distro builds that omit GPL components.
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
// transcode is bounded work, but MPEG-2 decode plus encoding on a modest
// server can still take tens of seconds. Kill anything that runs away.
const FFMPEG_TIMEOUT_MS = 120_000;

/** Mimes ensureTranscode can convert. */
export function transcodable(mime: string): boolean {
  return mime === "video/mpeg";
}

export interface TranscodeProfile {
  mime: "video/mp4" | "video/webm";
  ext: ".mp4" | ".webm";
  args: string[];
}

const MP4_PROFILE: TranscodeProfile = {
  mime: "video/mp4",
  ext: ".mp4",
  args: [
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k",
    // moov atom up front so playback starts before the download completes.
    "-movflags", "+faststart",
    "-f", "mp4",
  ],
};

const WEBM_PROFILE: TranscodeProfile = {
  mime: "video/webm",
  ext: ".webm",
  args: [
    "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-deadline", "good",
    "-cpu-used", "4", "-row-mt", "1", "-pix_fmt", "yuv420p",
    "-c:a", "libopus", "-b:a", "128k",
    "-f", "webm",
  ],
};

/** The output profile this `ffmpeg -encoders` listing supports, else null. */
export function detectProfile(encoders: string): TranscodeProfile | null {
  if (/^\s*V\S*\s+libx264\s/m.test(encoders)) return MP4_PROFILE;
  if (/^\s*V\S*\s+libvpx-vp9\s/m.test(encoders) && /^\s*A\S*\s+libopus\s/m.test(encoders)) {
    return WEBM_PROFILE;
  }
  return null;
}

// Feature detection, memoized for the process lifetime. A missing binary and
// a binary without a usable encoder pair degrade the same way.
let profile: Promise<TranscodeProfile | null> | null = null;

export function transcodeProfile(): Promise<TranscodeProfile | null> {
  profile ??= execFileP(FFMPEG_BIN, ["-hide_banner", "-encoders"], { timeout: 5_000 })
    .then(({ stdout }) => detectProfile(stdout))
    .catch(() => null);
  return profile;
}

/** Where a blob's cached transcode lives. Caller must have validated `sha256`. */
export function transcodePath(sha256: string, ext: string): string {
  return join(assetStoreDir(), ".transcode", `${sha256}${ext}`);
}

// One transcode per blob at a time: a gallery of players can fire several
// requests for the same asset before the first transcode finishes.
const inFlight = new Map<string, Promise<{ path: string; mime: string }>>();

/**
 * The cached browser-playable transcode for this blob, produced on first use.
 * Throws when ffmpeg is missing, errors on the input, or times out.
 */
export async function ensureTranscode(sha256: string): Promise<{ path: string; mime: string }> {
  const p = await transcodeProfile();
  if (!p) throw new Error("ffmpeg not available");
  const out = transcodePath(sha256, p.ext);
  try {
    if ((await stat(out)).size > 0) return { path: out, mime: p.mime };
  } catch {
    // Not cached yet.
  }
  let job = inFlight.get(sha256);
  if (!job) {
    job = transcode(sha256, out, p).finally(() => inFlight.delete(sha256));
    inFlight.set(sha256, job);
  }
  return job;
}

async function transcode(
  sha256: string,
  out: string,
  p: TranscodeProfile
): Promise<{ path: string; mime: string }> {
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
    // keep dimensions even (4:2:0 encoders reject odd sizes).
    "-vf",
    "yadif=deint=interlaced,scale=trunc(iw/2)*2:trunc(ih/2)*2",
    ...p.args,
    tmp,
  ];
  try {
    await execFileP(FFMPEG_BIN, args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4_000_000 });
    if ((await stat(tmp)).size === 0) throw new Error("empty transcode");
    await rename(tmp, out);
    return { path: out, mime: p.mime };
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
