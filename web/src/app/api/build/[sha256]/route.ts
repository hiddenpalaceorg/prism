import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { deriveQueryFeatures } from "@/lib/fingerprint";
import { getBuild, findSimilar, findByEmbedding } from "@/lib/queries";
import { embed, toPgVector } from "@/lib/embed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/build/<sha256> — the catalogued build plus its similar neighbors
// (same fusion as /api/similarity, computed from the stored record).
export async function GET(_request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  const pool = getPool();

  const build = await getBuild(pool, sha256);
  if (!build) return Response.json({ error: "not found" }, { status: 404 });

  const q = deriveQueryFeatures(build.record);
  const similar = await findSimilar(pool, q);

  let text_neighbors: Awaited<ReturnType<typeof findByEmbedding>> = [];
  if (build.record.text_doc) {
    const vec = toPgVector(await embed(build.record.text_doc));
    text_neighbors = await findByEmbedding(pool, vec, sha256);
  }

  return Response.json({ build, similar: { ...similar, text_neighbors } });
}
