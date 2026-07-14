import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { assetBlobPath } from "@/lib/assets";
import { referencedAssets, MAX_BUILD_ASSET_BYTES } from "@/lib/submission-assets";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUT /api/submissions/<sha256>/assets/<assetSha> — upload one asset blob (raw
// body). Accepted only when <assetSha> is referenced by the submission's (or
// an ingested build's) record, the size matches the record's claim, and the
// body actually hashes to <assetSha> — the content address is the authority;
// nothing else about the request is trusted. Idempotent by construction.
export async function PUT(
  request: NextRequest,
  ctx: { params: Promise<{ sha256: string; assetSha: string }> }
) {
  if (!rateLimit(`assets-put:${clientKey(request)}`, 240, 60_000)) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429 });
  }
  const { sha256, assetSha } = await ctx.params;
  if (!isSha256(sha256) || !isSha256(assetSha)) {
    return Response.json({ error: "invalid sha256" }, { status: 400 });
  }

  const refs = await referencedAssets(getPool(), sha256);
  if (!refs) return Response.json({ error: "not found" }, { status: 404 });
  const claimed = refs.sizes.get(assetSha);
  if (claimed === undefined) {
    return Response.json({ error: "asset not referenced by this build" }, { status: 404 });
  }
  if (refs.totalBytes > MAX_BUILD_ASSET_BYTES) {
    return Response.json({ error: "build's total asset bytes exceed the cap" }, { status: 413 });
  }

  const dest = assetBlobPath(assetSha);
  if (fs.existsSync(dest)) return Response.json({ sha256: assetSha, status: "exists" });

  // Stream with a running cap so an oversized/lying body dies early instead of
  // buffering; the record's claimed size is the per-blob budget.
  if (!request.body) return Response.json({ error: "missing body" }, { status: 400 });
  const hash = createHash("sha256");
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > claimed) {
      reader.cancel().catch(() => {});
      return Response.json({ error: "body exceeds the record's claimed size" }, { status: 413 });
    }
    hash.update(value);
    chunks.push(value);
  }
  if (received !== claimed) {
    return Response.json({ error: "body size does not match the record's claim" }, { status: 422 });
  }
  if (hash.digest("hex") !== assetSha) {
    return Response.json({ error: "body does not hash to the asset sha256" }, { status: 422 });
  }

  // Atomic write (tmp + rename), same as the bundle ingest path — a concurrent
  // upload of the same blob resolves to identical bytes either way.
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp${process.pid}`;
  try {
    await fsp.writeFile(tmp, Buffer.concat(chunks));
    await fsp.rename(tmp, dest);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return Response.json({ sha256: assetSha, status: "stored" }, { status: 201 });
}
