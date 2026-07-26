import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMagSession,
  dropMagSession,
  finishMagSession,
  isMagToken,
  magStagingPath,
  newMagToken,
  readMagSession,
  updateMagSession,
} from "../src/lib/mag/upload";

test("mag pdf session lifecycle: create, append, finish keeps the answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magupload-"));
  const saved = process.env.ASSET_STORE_DIR;
  process.env.ASSET_STORE_DIR = dir;
  try {
    const token = newMagToken();
    assert.ok(isMagToken(token));
    assert.ok(!isMagToken("xyz"));

    await createMagSession(token, { issue: 7, size: 10, author: "token" });
    const s = await readMagSession(token);
    assert.deepEqual(s, { issue: 7, size: 10, author: "token" });
    assert.equal((await stat(magStagingPath(token))).size, 0);

    await writeFile(magStagingPath(token), Buffer.from("0123456789"));
    assert.equal((await readFile(magStagingPath(token))).length, 10);

    await updateMagSession(token, { issue: 7, size: 10, author: "token" });
    await finishMagSession(token, { issue: 7, size: 10, author: "token" }, "ab".repeat(32));

    // Payload gone, sidecar replays the finished answer.
    await assert.rejects(stat(magStagingPath(token)));
    const done = await readMagSession(token);
    assert.equal(done?.done?.sha256, "ab".repeat(32));

    await dropMagSession(token);
    assert.equal(await readMagSession(token), null);
  } finally {
    if (saved === undefined) delete process.env.ASSET_STORE_DIR;
    else process.env.ASSET_STORE_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test("readMagSession returns null for unknown tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magupload-"));
  const saved = process.env.ASSET_STORE_DIR;
  process.env.ASSET_STORE_DIR = dir;
  try {
    assert.equal(await readMagSession(newMagToken()), null);
  } finally {
    if (saved === undefined) delete process.env.ASSET_STORE_DIR;
    else process.env.ASSET_STORE_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
