import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assetBlobPath,
  blobExists,
  blobSize,
  hasStagingHeadroom,
  missingBlobs,
  openBlobStream,
  readBlob,
  readBlobHead,
  reapStaleAssetStaging,
  storeBlobBytes,
  storeBlobFromFile,
  withBlobFile,
} from "../src/lib/blobstore";

// Local backend only (the s3 backend needs a live endpoint). The store dir is
// read per call, so pointing the env at a temp dir scopes every path in this
// file to it.
async function tempStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "blobstore-test-"));
  process.env.ASSET_STORE_DIR = dir;
  return dir;
}

const SHA_A = "aa".repeat(32);
const SHA_B = "bb".repeat(32);

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

test("blob reads answer null for a missing blob and bytes for a stored one", async () => {
  await tempStore();
  assert.equal(await blobSize(SHA_A), null);
  assert.equal(await blobExists(SHA_A), false);
  assert.equal(await readBlob(SHA_A), null);
  assert.equal(await readBlobHead(SHA_A), null);
  assert.equal(await openBlobStream(SHA_A), null);

  assert.equal(await storeBlobBytes(SHA_A, Buffer.from("hello blob")), true);
  assert.equal(await blobSize(SHA_A), 10);
  assert.equal((await readBlob(SHA_A))?.toString(), "hello blob");
  assert.equal((await readBlobHead(SHA_A, 5))?.toString(), "hello");
  // Re-storing an existing blob is a no-op.
  assert.equal(await storeBlobBytes(SHA_A, Buffer.from("hello blob")), false);
});

test("openBlobStream serves whole blobs and byte ranges", async () => {
  await tempStore();
  await storeBlobBytes(SHA_A, Buffer.from("0123456789"));
  assert.equal((await drain((await openBlobStream(SHA_A))!)).toString(), "0123456789");
  assert.equal((await drain((await openBlobStream(SHA_A, { start: 2, end: 5 }))!)).toString(), "2345");
});

test("missingBlobs preserves input order", async () => {
  await tempStore();
  await storeBlobBytes(SHA_B, Buffer.from("x"));
  assert.deepEqual(await missingBlobs([SHA_A, SHA_B]), [SHA_A]);
  assert.deepEqual(await missingBlobs([SHA_B]), []);
});

test("storeBlobFromFile moves, copies on keepSource, and answers exists", async () => {
  const dir = await tempStore();
  const src = join(dir, "staged.part");

  await writeFile(src, "staged bytes");
  assert.equal(await storeBlobFromFile(SHA_A, src), "stored");
  assert.equal(existsSync(src), false); // consumed
  assert.equal((await readBlob(SHA_A))?.toString(), "staged bytes");

  await writeFile(src, "staged bytes");
  assert.equal(await storeBlobFromFile(SHA_A, src), "exists");
  assert.equal(existsSync(src), false); // consumed even when already stored

  await writeFile(src, "kept bytes");
  assert.equal(await storeBlobFromFile(SHA_B, src, { keepSource: true }), "stored");
  assert.equal((await readFile(src)).toString(), "kept bytes"); // source intact
  assert.equal((await readBlob(SHA_B))?.toString(), "kept bytes");
});

test("withBlobFile hands the local blob path through and null when missing", async () => {
  await tempStore();
  assert.equal(await withBlobFile(SHA_A, async () => "ran"), null);
  await storeBlobBytes(SHA_A, Buffer.from("payload"));
  const got = await withBlobFile(SHA_A, async (p) => {
    assert.equal(p, assetBlobPath(SHA_A)); // local backend: no temp copy
    return (await readFile(p)).toString();
  });
  assert.equal(got, "payload");
});

test("reapStaleAssetStaging drops old .part files, keeps fresh and media ones", async () => {
  const dir = await tempStore();
  const staging = join(dir, ".staging");
  await mkdir(staging, { recursive: true });
  const old = join(staging, `${SHA_A}.part`);
  const fresh = join(staging, `${SHA_B}.part`);
  const media = join(staging, "media-deadbeef.part");
  for (const p of [old, fresh, media]) await writeFile(p, "x");
  const stale = new Date(Date.now() - 48 * 3600_000);
  await utimes(old, stale, stale);
  await utimes(media, stale, stale); // stale but not ours to reap

  await reapStaleAssetStaging();
  assert.equal(existsSync(old), false); // reaped
  assert.equal(existsSync(fresh), true); // too new
  assert.equal(existsSync(media), true); // media sessions reap themselves
});

test("hasStagingHeadroom refuses below the configured reserve", async () => {
  await tempStore();
  const prev = process.env.ASSET_STORE_MIN_FREE_BYTES;
  try {
    process.env.ASSET_STORE_MIN_FREE_BYTES = "0";
    assert.equal(await hasStagingHeadroom(0), true);
    // A reserve larger than any real disk forces a refusal.
    process.env.ASSET_STORE_MIN_FREE_BYTES = String(2 ** 62);
    assert.equal(await hasStagingHeadroom(0), false);
  } finally {
    if (prev === undefined) delete process.env.ASSET_STORE_MIN_FREE_BYTES;
    else process.env.ASSET_STORE_MIN_FREE_BYTES = prev;
  }
});

test("readBlobHead of an empty blob answers empty, not missing", async () => {
  await tempStore();
  const blob = assetBlobPath(SHA_A);
  await mkdir(dirname(blob), { recursive: true });
  await writeFile(blob, "");
  assert.equal((await readBlobHead(SHA_A))?.length, 0);
});
