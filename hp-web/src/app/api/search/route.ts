import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { search } from "@/lib/queries";
import { getModerator } from "@/lib/auth";
import { rateLimit, clientKey } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/search?q=... — filename FTS/fuzzy, or exact hash lookup.
// Moderators (wiki session or token) also see private builds.
export async function GET(request: NextRequest) {
  if (!rateLimit(`search:${clientKey(request)}`, 60, 60_000)) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429 });
  }
  const term = (request.nextUrl.searchParams.get("q")?.trim() ?? "").slice(0, 256);
  if (!term) return Response.json({ mode: "text", results: [] });
  const mod = await getModerator(request);
  const result = await search(getPool(), term, 50, !!mod);
  return Response.json(result);
}
