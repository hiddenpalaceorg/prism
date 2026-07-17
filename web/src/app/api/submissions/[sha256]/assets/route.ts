import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { missingBlobs } from "@/lib/blobstore";
import { referencedAssets } from "@/lib/submission-assets";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/submissions/<sha256>/assets — which of the build's referenced asset
// blobs are absent from the store. Desktop apps call this after submitting a
// record, then PUT only the missing blobs.
export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  if (!rateLimit(`assets-check:${clientKey(request)}`, 60, 60_000)) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429 });
  }
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const refs = await referencedAssets(getPool(), sha256);
  if (!refs) return Response.json({ error: "not found" }, { status: 404 });

  const missing = await missingBlobs([...refs.sizes.keys()]);
  return Response.json({ sha256, referenced: refs.sizes.size, missing });
}
