import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { assetBlobPath } from "../src/lib/assets";
import { ensureMp4, ffmpegAvailable, mp4Transcodable, transcodePath } from "../src/lib/ffmpeg";

const execFileP = promisify(execFile);

// Transcode tests need real ffmpeg and skip without it (set FFMPEG_BIN when
// `ffmpeg` isn't on PATH).

test("mp4Transcodable covers exactly the MPEG program-stream mime", () => {
  assert.equal(mp4Transcodable("video/mpeg"), true);
  assert.equal(mp4Transcodable("video/mp4"), false);
  assert.equal(mp4Transcodable("video/webm"), false);
  assert.equal(mp4Transcodable("audio/mpeg"), false);
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

test("ensureMp4 transcodes an MPEG-PS blob and caches the result", async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg not installed");
  const dir = await tempStore();
  try {
    const sha = "aa".repeat(32);
    const mpeg = await mpegFixture(dir);
    // The fixture must open on the pack start code viewable.py sniffs for.
    assert.deepEqual([...mpeg.subarray(0, 4)], [0x00, 0x00, 0x01, 0xba]);
    await putBlob(sha, mpeg);

    const out = await ensureMp4(sha);
    assert.equal(out, transcodePath(sha));
    const mp4 = await readFile(out);
    assert.equal(mp4.subarray(4, 8).toString("latin1"), "ftyp");
    // faststart must have moved the moov atom ahead of the media data.
    assert.ok(mp4.indexOf("moov") < mp4.indexOf("mdat"), "moov after mdat");

    // Second call serves the cache, so the file must not be rewritten.
    const before = (await stat(out)).mtimeMs;
    assert.equal(await ensureMp4(sha), out);
    assert.equal((await stat(out)).mtimeMs, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureMp4 rejects junk that is not a video stream", async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg not installed");
  const dir = await tempStore();
  try {
    const sha = "bb".repeat(32);
    await putBlob(sha, Buffer.from("\x00\x00\x01\xbanot really mpeg data", "latin1"));
    await assert.rejects(ensureMp4(sha));
    // A failed transcode must leave no cached output (or stray .part files).
    await assert.rejects(stat(transcodePath(sha)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureMp4 rejects a blob missing from the store", async (t) => {
  if (!(await ffmpegAvailable())) return t.skip("ffmpeg not installed");
  const dir = await tempStore();
  try {
    await assert.rejects(ensureMp4("cc".repeat(32)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
