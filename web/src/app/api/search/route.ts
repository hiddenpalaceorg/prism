import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { search } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/search?q=... — filename FTS/fuzzy, or exact hash lookup.
export async function GET(request: NextRequest) {
  const term = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!term) return Response.json({ mode: "text", results: [] });
  const result = await search(getPool(), term);
  return Response.json(result);
}
