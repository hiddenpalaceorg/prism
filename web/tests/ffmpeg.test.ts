import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { assetBlobPath } from "../src/lib/assets";
import {
  detectProfile,
  ensureThumb,
  ensureTranscode,
  thumbPath,
  transcodable,
  transcodePath,
  transcodeProfile,
  transcodeStatus,
} from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);

// Transcode tests need real ffmpeg and skip without it (set FFMPEG_BIN when
// `ffmpeg` isn't on PATH).

test("transcodable covers exactly the MPEG program-stream mime", () => {
  assert.equal(transcodable("video/mpeg"), true);
  assert.equal(transcodable("video/mp4"), false);
  assert.equal(transcodable("video/webm"), false);
  assert.equal(transcodable("audio/mpeg"), false);
});

// Encoder listings in `ffmpeg -encoders` format: flags column, name, blurb.
const X264_LINE = " V....D libx264              libx264 H.264 / AVC (codec h264)\n";
const VP9_LINE = " V....D libvpx-vp9           libvpx VP9 (codec vp9)\n";
const OPUS_LINE = " A....D libopus              libopus Opus (codec opus)\n";
const AAC_LINE = " A....D aac                  AAC (Advanced Audio Coding)\n";

test("detectProfile prefers H.264 MP4 and falls back to VP9 WebM", () => {
  assert.equal(detectProfile(X264_LINE + VP9_LINE + OPUS_LINE + AAC_LINE)?.mime, "video/mp4");
  // A GPL-less distro build: no libx264, but libvpx + libopus present.
  assert.equal(detectProfile(VP9_LINE + OPUS_LINE + AAC_LINE)?.mime, "video/webm");
  // No usable encoder pair at all.
  assert.equal(detectProfile(AAC_LINE), null);
  assert.equal(detectProfile(VP9_LINE + AAC_LINE), null);
  // The name must match whole, not as a prefix of something else.
  assert.equal(detectProfile(" V....D libx264rgb           libx264 RGB (codec h264)\n"), null);
});

// The store dir is read per call, so pointing the env at a temp dir scopes
// every blob/transcode path in this file to it.
async function tempStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ffmpeg-test-"));
  process.env.ASSET_STORE_DIR = dir;
  return dir;
}

/** Drop `bytes` into the store as blob `sha` (any 64-hex name will do). */
async function putBlob(sha: string, bytes: Buffer): Promise<void> {
  const blob = assetBlobPath(sha);
  await mkdir(dirname(blob), { recursive: true });
  await writeFile(blob, bytes);
}

/** A 1s 64x48 MPEG-2 program stream with MP2 audio, VOB-shaped content. */
async function mpegFixture(dir: string): Promise<Buffer> {
  const out = join(dir, "fixture.mpg");
  await execFileP(process.env.FFMPEG_BIN || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=1:size=64x48:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "mpeg2video", "-c:a", "mp2", "-f", "mpeg",
    out,
  ]);
  return readFile(out);
}

test("ensureTranscode converts an MPEG-PS blob and caches the result", async (t) => {
  const profile = await transcodeProfile();
  if (!profile) return t.skip("ffmpeg not installed");
  const dir = await tempStore();
  try {
    const sha = "aa".repeat(32);
    const mpeg = await mpegFixture(dir);
    // The fixture must open on the pack start code viewable.py sniffs for.
    assert.deepEqual([...mpeg.subarray(0, 4)], [0x00, 0x00, 0x01, 0xba]);
    await putBlob(sha, mpeg);

    const video = await ensureTranscode(sha);
    assert.equal(video.path, transcodePath(sha, profile.ext));
    assert.equal(video.mime, profile.mime);
    const bytes = await readFile(video.path);
    if (profile.mime === "video/mp4") {
      assert.equal(bytes.subarray(4, 8).toString("latin1"), "ftyp");
      // faststart must have moved the moov atom ahead of the media data.
      assert.ok(bytes.indexOf("moov") < bytes.indexOf("mdat"), "moov after mdat");
    } else {
      // EBML header opens every WebM file.
      assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
    }

    // Second call serves the cache, so the file must not be rewritten.
    const before = (await stat(video.path)).mtimeMs;
    assert.equal((await ensureTranscode(sha)).path, video.path);
    assert.equal((await stat(video.path)).mtimeMs, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureTranscode rejects junk that is not a video stream", async (t) => {
  const profile = await transcodeProfile();
  if (!profile) return t.skip("ffmpeg not installed");
  const dir = await tempStore();
  try {
    const sha = "bb".repeat(32);
    await putBlob(sha, Buffer.from("\x00\x00\x01\xbanot really mpeg data", "latin1"));
    await assert.rejects(ensureTranscode(sha));
    // A failed transcode must leave no cached output (or stray .part files).
    await assert.rejects(stat(transcodePath(sha, profile.ext)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureTranscode rejects a blob missing from the store", async (t) => {
  if (!(await transcodeProfile())) return t.skip("ffmpeg not installed");
  const dir = await tempStore();
  try {
    await assert.rejects(ensureTranscode("cc".repeat(32)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureTranscode serves a precomputed transcode of either extension", async (t) => {
  const profile = await transcodeProfile();
  if (!profile) return t.skip("ffmpeg not installed");
  const dir = await tempStore();
  try {
    // Plant a cached transcode under the extension the local profile would
    // NOT produce — a transcode shipped in from a better-equipped machine.
    const sha = "dd".repeat(32);
    const otherExt = profile.ext === ".mp4" ? ".webm" : ".mp4";
    const planted = transcodePath(sha, otherExt);
    await mkdir(dirname(planted), { recursive: true });
    await writeFile(planted, Buffer.from("sentinel"));

    const video = await ensureTranscode(sha); // no blob in store: must not transcode
    assert.equal(video.path, planted);
    assert.equal(video.mime, otherExt === ".webm" ? "video/webm" : "video/mp4");
    assert.deepEqual(await transcodeStatus(sha), { state: "ready", path: planted, mime: video.mime });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transcodeStatus reports failed after a rejected transcode, none when idle", async (t) => {
  if (!(await transcodeProfile())) return t.skip("ffmpeg not installed");
  const dir = await tempStore();
  try {
    const sha = "ee".repeat(32);
    assert.deepEqual(await transcodeStatus(sha), { state: "none" });
    await putBlob(sha, Buffer.from("\x00\x00\x01\xbajunk", "latin1"));
    await assert.rejects(ensureTranscode(sha));
    assert.deepEqual(await transcodeStatus(sha), { state: "failed" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureThumb extracts a JPEG still and caches it", async (t) => {
  if (!(await transcodeProfile())) return t.skip("ffmpeg not installed");
  const dir = await tempStore();
  try {
    const sha = "ff".repeat(32);
    await putBlob(sha, await mpegFixture(dir));
    const out = await ensureThumb(sha);
    assert.equal(out, thumbPath(sha));
    const bytes = await readFile(out);
    // JPEG SOI marker.
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);

    // Second call serves the cache, so the file must not be rewritten.
    const before = (await stat(out)).mtimeMs;
    assert.equal(await ensureThumb(sha), out);
    assert.equal((await stat(out)).mtimeMs, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureThumb rejects junk and a missing blob", async (t) => {
  if (!(await transcodeProfile())) return t.skip("ffmpeg not installed");
  const dir = await tempStore();
  try {
    const sha = "ab".repeat(32);
    await putBlob(sha, Buffer.from("not a video at all"));
    await assert.rejects(ensureThumb(sha));
    await assert.rejects(stat(thumbPath(sha)));
    await assert.rejects(ensureThumb("cd".repeat(32)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
