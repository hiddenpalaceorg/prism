import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { submissionStatus } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/submissions/<sha256> — submission status (params is a Promise in Next 16).
export async function GET(_request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  const status = await submissionStatus(getPool(), sha256);
  if (!status) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(status);
}
