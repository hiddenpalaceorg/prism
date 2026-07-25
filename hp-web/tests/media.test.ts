import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMediaSession,
  dropMediaSession,
  finishMediaSession,
  inferMediaLabel,
  isMediaKind,
  isMediaLabel,
  mediaStagingPath,
  readMediaSession,
  sniffMedia,
  updateMediaSession,
  withMediaSession,
  type BuildMediaView,
  type MediaSession,
} from "../src/lib/media";

test("inferMediaLabel reads the front/back convention out of filenames", () => {
  assert.equal(inferMediaLabel("Earthworm Jim Front.png"), "front");
  assert.equal(inferMediaLabel("Earthworm Jim Sega Genesis ROM Image Back.png"), "back");
  assert.equal(inferMediaLabel("front.jpg"), "front");
  assert.equal(inferMediaLabel("FRONT COVER.png"), "front");
  assert.equal(inferMediaLabel("disc_front_scan.png"), "front");
  assert.equal(inferMediaLabel("back-of-case.jpg"), "back");
});

test("inferMediaLabel does not fire inside larger words", () => {
  assert.equal(inferMediaLabel("backyard.png"), "other");
  assert.equal(inferMediaLabel("frontier-demo.png"), "other");
  assert.equal(inferMediaLabel("IMG_2041.jpg"), "other");
});

test("inferMediaLabel prefers front when a name carries both words", () => {
  assert.equal(inferMediaLabel("front and back.png"), "front");
});

test("media kind and label guards accept only known values", () => {
  assert.equal(isMediaKind("physical"), true);
  assert.equal(isMediaKind("photo"), false);
  assert.equal(isMediaLabel("front"), true);
  assert.equal(isMediaLabel("side"), false);
  assert.equal(isMediaLabel(null), false);
});

test("sniffMedia identifies the accepted containers by magic bytes", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.deepEqual(sniffMedia(png), { contentType: "image/png", video: false });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(sniffMedia(jpeg), { contentType: "image/jpeg", video: false });
  assert.equal(sniffMedia(Buffer.from("not an image at all!")), null);
});

// ── upload sessions ──────────────────────────────────────────────────────────
// The store dir is read per call, so pointing the env at a temp dir scopes
// every session path in these tests to it.

async function tempStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "media-test-"));
  process.env.ASSET_STORE_DIR = dir;
  return dir;
}

const TOKEN = "0".repeat(32);

const SESSION: MediaSession = {
  build: "ab".repeat(32),
  kind: "physical",
  filename: "Front.png",
  size: 12,
  author: "someone",
};

const ROW = { id: 7, sha256: "cd".repeat(32), filename: "Front.png" } as BuildMediaView;

test("a new session round-trips and stages an empty payload", async () => {
  await tempStore();
  await createMediaSession(TOKEN, SESSION);
  assert.deepEqual(await readMediaSession(TOKEN), SESSION);
  assert.equal((await stat(mediaStagingPath(TOKEN))).size, 0);
});

test("readMediaSession answers null for a token that was never opened", async () => {
  await tempStore();
  assert.equal(await readMediaSession(TOKEN), null);
});

test("updateMediaSession leaves no temp file behind", async () => {
  const dir = await tempStore();
  await createMediaSession(TOKEN, SESSION);
  await updateMediaSession(TOKEN, { ...SESSION, contentType: "image/png" });

  assert.equal((await readMediaSession(TOKEN))?.contentType, "image/png");
  const staging = await readdir(join(dir, ".staging"));
  assert.deepEqual(
    staging.filter((n) => n.includes(".tmp")),
    []
  );
});

test("a finished session drops its payload but replays the row it produced", async () => {
  await tempStore();
  await createMediaSession(TOKEN, SESSION);
  await writeFile(mediaStagingPath(TOKEN), Buffer.alloc(SESSION.size));

  await finishMediaSession(TOKEN, SESSION, ROW);

  // This is what makes a duplicate PUT safe: the bytes are gone, but the
  // session still knows the answer, so a client whose reply went missing is
  // told the upload worked instead of 404'd for a file that is on the site.
  assert.equal(existsSync(mediaStagingPath(TOKEN)), false);
  assert.deepEqual((await readMediaSession(TOKEN))?.done, ROW);
});

test("dropMediaSession removes both halves", async () => {
  await tempStore();
  await createMediaSession(TOKEN, SESSION);
  await dropMediaSession(TOKEN);
  assert.equal(await readMediaSession(TOKEN), null);
  assert.equal(existsSync(mediaStagingPath(TOKEN)), false);
});

test("withMediaSession runs one request per token at a time", async () => {
  const order: string[] = [];
  const slow = async (name: string, ms: number) => {
    order.push(`${name}:start`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${name}:end`);
  };

  await Promise.all([
    withMediaSession(TOKEN, () => slow("a", 20)),
    withMediaSession(TOKEN, () => slow("b", 1)),
  ]);

  // Not a:start, b:start, b:end, a:end. The second waits out the first, so
  // two appends can never both pass the same offset check.
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
});

test("withMediaSession lets a different token run concurrently", async () => {
  const other = "1".repeat(32);
  const order: string[] = [];
  await Promise.all([
    withMediaSession(TOKEN, async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a:end");
    }),
    withMediaSession(other, async () => {
      order.push("b:start");
      order.push("b:end");
    }),
  ]);
  assert.deepEqual(order, ["a:start", "b:start", "b:end", "a:end"]);
});

test("withMediaSession is not wedged by a request that threw", async () => {
  await assert.rejects(
    withMediaSession(TOKEN, () => Promise.reject(new Error("boom"))),
    /boom/
  );
  // A failed chunk must not take the token down with it: the retry that
  // rescues the upload is the very next request on it.
  assert.equal(await withMediaSession(TOKEN, () => Promise.resolve("ok")), "ok");
});
