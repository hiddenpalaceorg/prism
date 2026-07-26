import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { getIssueById } from "@/lib/mag/queries";
import { ensureIssueAssets, issueAssetsPending, issueAssetStatus } from "@/lib/mag/store";
import { clientKey, rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/mag/issues/<id>/status — render/crop progress plus extract counts.
// Public (the issue page shows a "rendering" note), and self-healing: when
// work is pending and no job is running, polling restarts it — same contract
// as the video transcode status route, so a server restart mid-render needs
// nothing but the next poll.
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!rateLimit(`magstatus:${clientKey(request)}`, 120, 60_000)) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429 });
  }
  const raw = (await ctx.params).id;
  if (!/^\d{1,10}$/.test(raw)) return Response.json({ error: "invalid issue id" }, { status: 400 });
  const id = parseInt(raw, 10);
  const pool = getPool();
  const issue = await getIssueById(pool, id);
  if (!issue) return Response.json({ error: "no such issue" }, { status: 404 });

  if (await issueAssetsPending(pool, id)) ensureIssueAssets(pool, id);
  const assets = await issueAssetStatus(pool, id);
  const extracts = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='auto')::int AS auto,
            count(*) FILTER (WHERE status='amended')::int AS amended,
            count(*) FILTER (WHERE status='rejected')::int AS rejected
     FROM magazine_extract WHERE issue_id=$1`,
    [id]
  );
  return new Response(JSON.stringify({ issue: issue.status, assets, extracts: extracts.rows[0] }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
