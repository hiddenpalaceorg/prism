import type { NextRequest } from "next/server";
import { commitsPage, resolveRev } from "@/lib/repo-manifest";
import { loadRepo, repoAttached } from "@/lib/repo";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/repo/<manifest sha256>/commits?rev=&offset=&limit= — one page of
// the commit log reachable from a revision, newest-first. Immutable per URL
// (content-addressed manifest).
const CACHE = "public, max-age=31536000, immutable";

export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  if (!(await repoAttached(sha256))) return Response.json({ error: "not found" }, { status: 404 });
  const idx = await loadRepo(sha256);
  if (!idx) return Response.json({ error: "repository data not in store" }, { status: 404 });

  const params = request.nextUrl.searchParams;
  const rev = resolveRev(idx, params.get("rev") ?? "");
  if (!rev) return Response.json({ error: "unknown revision" }, { status: 404 });
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  // The viewer fetches the whole log in one request (compact rows, no
  // pagination); the cap only guards against absurd asks.
  const limit = Math.min(50_000, Math.max(1, Number(params.get("limit")) || 100));

  const page = commitsPage(idx, rev, offset, limit);
  return Response.json(
    { rev, total: page.total, offset, commits: page.commits },
    { headers: { "Cache-Control": CACHE } }
  );
}
