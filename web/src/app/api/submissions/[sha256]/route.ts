import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { submissionStatus, setSubmissionStatus } from "@/lib/queries";
import { ingestRecord } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/submissions/<sha256> — submission status (params is a Promise in Next 16).
export async function GET(_request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  const status = await submissionStatus(getPool(), sha256);
  if (!status) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(status);
}

// POST /api/submissions/<sha256> { action: "accept" | "reject" } — moderate.
// Accept ingests the stored record into the catalog, then marks it accepted.
export async function POST(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  let action: string | undefined;
  try {
    ({ action } = await request.json());
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (action !== "accept" && action !== "reject") {
    return Response.json({ error: 'action must be "accept" or "reject"' }, { status: 400 });
  }

  const pool = getPool();
  const record = await setSubmissionStatus(pool, sha256, action === "accept" ? "accepted" : "rejected");
  if (!record) return Response.json({ error: "not found" }, { status: 404 });

  if (action === "accept") {
    await ingestRecord(pool, record);
  }
  return Response.json({ sha256, status: action === "accept" ? "accepted" : "rejected" });
}
