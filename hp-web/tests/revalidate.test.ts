import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PEER_HEADER,
  isRevalidatePath,
  isRevalidateTag,
  peerRevalidateRequest,
} from "../src/lib/revalidate";

const ENV = { PEER_ORIGIN: "http://127.0.0.1:6802", REFRESH_TOKEN: "s3cret" };

test("peerRevalidateRequest posts the paths to the sibling's refresh endpoint", () => {
  const req = peerRevalidateRequest(["/builds", "/builds/foo"], ["build-tree:abc"], ENV);
  assert.ok(req);
  assert.equal(req.url, "http://127.0.0.1:6802/api/refresh");
  assert.equal(req.init.method, "POST");
  const headers = req.init.headers as Record<string, string>;
  assert.equal(headers["x-refresh-token"], "s3cret");
  assert.equal(headers[PEER_HEADER], "1"); // receiver must not mirror it back
  assert.deepEqual(JSON.parse(req.init.body as string), {
    paths: ["/builds", "/builds/foo"],
    tags: ["build-tree:abc"],
  });
});

test("peerRevalidateRequest tolerates a trailing slash on PEER_ORIGIN", () => {
  const req = peerRevalidateRequest(["/builds"], [], { ...ENV, PEER_ORIGIN: "http://127.0.0.1:6802/" });
  assert.equal(req?.url, "http://127.0.0.1:6802/api/refresh");
});

test("peerRevalidateRequest is null with no sibling, no token, or nothing to send", () => {
  assert.equal(peerRevalidateRequest(["/builds"], [], { REFRESH_TOKEN: "s3cret" }), null);
  assert.equal(peerRevalidateRequest(["/builds"], [], { PEER_ORIGIN: ENV.PEER_ORIGIN }), null);
  assert.equal(peerRevalidateRequest([], [], ENV), null);
});

test("isRevalidatePath takes app paths and rejects anything host-shaped", () => {
  assert.equal(isRevalidatePath("/builds"), true);
  assert.equal(isRevalidatePath("/builds/sonic-the-hedgehog--genesis/assets"), true);
  assert.equal(isRevalidatePath("builds"), false);
  assert.equal(isRevalidatePath("//evil.example.com/"), false);
  assert.equal(isRevalidatePath("http://evil.example.com/"), false);
  assert.equal(isRevalidatePath("/builds\n/other"), false);
  assert.equal(isRevalidatePath("/" + "x".repeat(600)), false);
  assert.equal(isRevalidatePath(""), false);
  assert.equal(isRevalidatePath(42), false);
});

test("isRevalidateTag takes the app's tag shape only", () => {
  assert.equal(isRevalidateTag("build-tree:8ab3"), true);
  assert.equal(isRevalidateTag("build tree"), false);
  assert.equal(isRevalidateTag(""), false);
  assert.equal(isRevalidateTag("x".repeat(129)), false);
  assert.equal(isRevalidateTag(null), false);
});
