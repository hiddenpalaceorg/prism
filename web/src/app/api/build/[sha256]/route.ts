import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { deriveQueryFeatures } from "@/lib/fingerprint";
import { getBuild, findSimilar, findByEmbeddingOf } from "@/lib/queries";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/build/<sha256> — the stored build plus its similar neighbors
// (same fusion as /api/similarity, computed from the stored record).
export async function GET(_request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  const pool = getPool();

  const build = await getBuild(pool, sha256);
  if (!build) return Response.json({ error: "not found" }, { status: 404 });

  const q = deriveQueryFeatures(build.record);
  const similar = await findSimilar(pool, q);

  // Use the build's STORED embedding (pgvector) rather than re-running the
  // transformers model on its text_doc at request time — same neighbors, no
  // model load/inference on the hot path (the GUIs hit this endpoint).
  const text_neighbors = await findByEmbeddingOf(pool, sha256);

  return Response.json({ build, similar: { ...similar, text_neighbors } });
}
