import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assetBlobPath,
  blobBuffered,
  blobExists,
  blobSize,
  missingBlobs,
  openBlobStream,
  readBlob,
  readBlobHead,
  storeBlobBuffered,
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

test("readBlobHead of an empty blob answers empty, not missing", async () => {
  await tempStore();
  const blob = assetBlobPath(SHA_A);
  await mkdir(dirname(blob), { recursive: true });
  await writeFile(blob, "");
  assert.equal((await readBlobHead(SHA_A))?.length, 0);
});

test("storeBlobBuffered without the s3 backend is a plain local store", async () => {
  const dir = await tempStore();
  const src = join(dir, "buffered.part");
  await writeFile(src, "buffered bytes");
  assert.equal(await storeBlobBuffered(SHA_A, src), "stored");
  assert.equal(existsSync(src), false); // consumed
  assert.equal((await readBlob(SHA_A))?.toString(), "buffered bytes");
  assert.equal(blobBuffered(SHA_A), false); // no bucket, nothing to drain
});

// The env is read per call, so a locally present blob must be answered from
// disk without the S3 client ever being built — an unroutable endpoint makes
// any accidental network attempt fail loudly. Keep this test last: the
// client memoizes its config on first construction.
test("reads are local-first under the s3 backend", async () => {
  await tempStore();
  process.env.ASSET_S3_ENDPOINT = "https://127.0.0.1:1";
  try {
    const blob = assetBlobPath(SHA_A);
    await mkdir(dirname(blob), { recursive: true });
    await writeFile(blob, "local wins");
    assert.equal((await readBlob(SHA_A))?.toString(), "local wins");
    assert.equal(await blobSize(SHA_A), 10);
    assert.equal(await blobExists(SHA_A), true);
    assert.deepEqual(await missingBlobs([SHA_A]), []);
    const got = await withBlobFile(SHA_A, async (p) => {
      assert.equal(p, blob); // served from disk, not materialized
      return "ok";
    });
    assert.equal(got, "ok");
  } finally {
    delete process.env.ASSET_S3_ENDPOINT;
  }
});
