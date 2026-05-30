import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { enqueueSubmission, listSubmissions } from "@/lib/queries";
import { isModerator, moderationToken } from "@/lib/auth";
import { MAX_BODY_BYTES, validateBuildRecord } from "@/lib/validate";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import type { BuildRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/submissions?status=queued — the moderation queue. Requires a configured token.
export async function GET(request: NextRequest) {
  if (!moderationToken()) {
    return Response.json({ error: "moderation disabled (set MODERATION_TOKEN)" }, { status: 403 });
  }
  if (!isModerator(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const status = request.nextUrl.searchParams.get("status") ?? undefined;
  const items = await listSubmissions(getPool(), status);
  return Response.json({ submissions: items });
}

// POST { nickname, record } — enqueue a build for moderation/ingest (dedup by sha256).
export async function POST(request: NextRequest) {
  if (!rateLimit(`submissions:${clientKey(request)}`, 30, 60_000)) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429 });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ error: "request body too large" }, { status: 413 });
  }
  let body: { nickname?: string; record?: BuildRecord };
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { nickname } = body;
  if (!nickname) {
    return Response.json({ error: "require { nickname, record(with image.sha256) }" }, { status: 400 });
  }
  const v = validateBuildRecord(body.record);
  if (!v.ok) {
    return Response.json({ error: v.error }, { status: 422 });
  }
  try {
    const sha256 = await enqueueSubmission(getPool(), nickname, v.record);
    return Response.json({ sha256, status: "queued" }, { status: 202 });
  } catch {
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
