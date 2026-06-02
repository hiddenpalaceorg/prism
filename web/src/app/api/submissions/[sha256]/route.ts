import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { submissionStatus, setSubmissionStatus } from "@/lib/queries";
import { ingestRecord } from "@/lib/ingest";
import { isModerator, moderationToken } from "@/lib/auth";
import { isSha256 } from "@/lib/validate";
import type { BuildRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/submissions/<sha256> — submission status (params is a Promise in Next 16).
export async function GET(_request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  const status = await submissionStatus(getPool(), sha256);
  if (!status) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(status);
}

// POST /api/submissions/<sha256> { action: "accept" | "reject" } — moderate.
// Accept ingests the stored record into the library, then marks it accepted.
export async function POST(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  if (!isModerator(request)) {
    return moderationToken()
      ? Response.json({ error: "unauthorized" }, { status: 401 })
      : Response.json({ error: "moderation disabled (set MODERATION_TOKEN)" }, { status: 403 });
  }
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
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

  if (action === "reject") {
    const record = await setSubmissionStatus(pool, sha256, "rejected");
    if (!record) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ sha256, status: "rejected" });
  }

  // Accept: ingest and flip status to accepted in ONE transaction so a failed
  // ingest never leaves the submission marked accepted.
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query<{ record: BuildRecord }>(
      "SELECT record FROM submission_queue WHERE sha256=$1 FOR UPDATE",
      [sha256]
    );
    if (!r.rowCount) {
      await c.query("ROLLBACK");
      return Response.json({ error: "not found" }, { status: 404 });
    }
    await ingestRecord(c, r.rows[0].record);
    await c.query(
      "UPDATE submission_queue SET status='accepted', reviewed_at=now() WHERE sha256=$1",
      [sha256]
    );
    await c.query("COMMIT");
  } catch {
    await c.query("ROLLBACK");
    return Response.json({ error: "ingest failed" }, { status: 500 });
  } finally {
    c.release();
  }
  return Response.json({ sha256, status: "accepted" });
}
