import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { deriveQueryFeatures } from "@/lib/fingerprint";
import { findSimilar, findByEmbedding, logCheck } from "@/lib/queries";
import { embed, toPgVector } from "@/lib/embed";
import { MAX_BODY_BYTES, validateBuildRecord } from "@/lib/validate";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import type { BuildRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST a canonical BuildRecord; returns fused Tier 1/2/3 neighbors. Read-only:
// the submitted build is logged (by sha256) but not ingested.
export async function POST(request: NextRequest) {
  if (!rateLimit(`similarity:${clientKey(request)}`, 30, 60_000)) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429 });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ error: "request body too large" }, { status: 413 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const v = validateBuildRecord(parsed);
  if (!v.ok) {
    return Response.json({ error: v.error }, { status: 422 });
  }
  const record: BuildRecord = v.record;

  try {
    const pool = getPool();
    const q = deriveQueryFeatures(record);
    await logCheck(pool, q.sha256);
    const result = await findSimilar(pool, q);

    // Tier-text: semantic neighbors via the text embedding.
    let text_neighbors: Awaited<ReturnType<typeof findByEmbedding>> = [];
    if (record.text_doc) {
      const vec = toPgVector(await embed(record.text_doc));
      text_neighbors = await findByEmbedding(pool, vec, q.sha256 ?? "");
    }

    return Response.json({ query: { sha256: q.sha256, name: q.name }, ...result, text_neighbors });
  } catch {
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
