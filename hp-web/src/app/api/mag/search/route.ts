import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { searchExtracts } from "@/lib/mag/queries";
import { clientKey, rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/mag/search?q=...&magazine=&kind=&system=&language=&person=&game=
//   &from=&to=&limit= — extract search. Quoted q ("...") is exact substring
// (trigram; the CJK path); otherwise FTS over original + English text.
export async function GET(request: NextRequest) {
  if (!rateLimit(`magsearch:${clientKey(request)}`, 60, 60_000)) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429 });
  }
  const p = request.nextUrl.searchParams;
  const q = (p.get("q") ?? "").trim().slice(0, 256);
  if (!q) return Response.json({ results: [] });
  const date = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const results = await searchExtracts(getPool(), q, {
    magazine: p.get("magazine")?.slice(0, 100) || undefined,
    kind: p.get("kind")?.slice(0, 40) || undefined,
    system: p.get("system")?.slice(0, 100) || undefined,
    language: p.get("language")?.slice(0, 20) || undefined,
    person: p.get("person")?.slice(0, 200) || undefined,
    game: p.get("game")?.slice(0, 200) || undefined,
    from: date(p.get("from")),
    to: date(p.get("to")),
    limit: Number(p.get("limit")) || undefined,
  });
  return Response.json({ results });
}
