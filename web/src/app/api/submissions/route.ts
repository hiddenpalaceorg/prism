import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { enqueueSubmission, listSubmissions } from "@/lib/queries";
import { isModerator, moderationToken } from "@/lib/auth";
import type { BuildRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/submissions?status=queued — the moderation queue. Gated when a token is set.
export async function GET(request: NextRequest) {
  if (moderationToken() && !isModerator(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const status = request.nextUrl.searchParams.get("status") ?? undefined;
  const items = await listSubmissions(getPool(), status);
  return Response.json({ submissions: items });
}

// POST { nickname, record } — enqueue a build for moderation/ingest (dedup by sha256).
export async function POST(request: NextRequest) {
  let body: { nickname?: string; record?: BuildRecord };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { nickname, record } = body;
  if (!nickname || !record?.image?.sha256) {
    return Response.json({ error: "require { nickname, record(with image.sha256) }" }, { status: 400 });
  }
  const sha256 = await enqueueSubmission(getPool(), nickname, record);
  return Response.json({ sha256, status: "queued" }, { status: 202 });
}
