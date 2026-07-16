import type { NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getPool } from "@/lib/db";
import { deriveQueryFeatures } from "@/lib/fingerprint";
import { getBuild, findSimilar, findByEmbeddingOf, getLotBuilds, updateBuildMeta } from "@/lib/queries";
import { getModerator, moderationEnabled } from "@/lib/auth";
import { buildHref } from "@/lib/slug";
import { isSha256 } from "@/lib/validate";

const MAX_NAME_LEN = 300;
const MAX_LOT_LEN = 200;

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

// PATCH /api/build/<sha256> { name?, lot? } — moderator metadata edit.
// `name` renames the build; `lot` assigns it to a display group ("" or null clears).
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  if (!(await getModerator(request))) {
    return moderationEnabled()
      ? Response.json({ error: "unauthorized" }, { status: 401 })
      : Response.json({ error: "moderation disabled (set MODERATION_TOKEN or WIKI_API_URL)" }, { status: 403 });
  }
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const fields: { name?: string; lot?: string | null } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return Response.json({ error: "name must be a non-empty string" }, { status: 400 });
    }
    if (body.name.length > MAX_NAME_LEN) {
      return Response.json({ error: `name exceeds ${MAX_NAME_LEN} characters` }, { status: 400 });
    }
    fields.name = body.name.trim();
  }
  if (body.lot !== undefined) {
    if (body.lot !== null && typeof body.lot !== "string") {
      return Response.json({ error: "lot must be a string or null" }, { status: 400 });
    }
    if (typeof body.lot === "string" && body.lot.length > MAX_LOT_LEN) {
      return Response.json({ error: `lot exceeds ${MAX_LOT_LEN} characters` }, { status: 400 });
    }
    fields.lot = (body.lot ?? "").trim() || null;
  }
  if (fields.name === undefined && fields.lot === undefined) {
    return Response.json({ error: "nothing to update (name and/or lot required)" }, { status: 400 });
  }

  const pool = getPool();
  const prev = await updateBuildMeta(pool, sha256, fields);
  if (!prev) return Response.json({ error: "not found" }, { status: 404 });

  // Build pages are ISR-cached (revalidate = 3600); surface the edit now. A
  // rename changes the canonical slug path, so refresh the old one (it now
  // serves a redirect) and the new one, plus their assets subpages and the
  // bare-sha redirect. A lot change also alters the lot section on every
  // sibling page, in the lot the build joined and the one it left.
  revalidatePath("/builds");
  const touched = new Set([
    buildHref(sha256, prev.name),
    buildHref(sha256, fields.name ?? prev.name),
    `/builds/${sha256}`,
  ]);
  if (fields.lot !== undefined && fields.lot !== prev.lot) {
    const lots = [fields.lot, prev.lot].filter((l): l is string => l != null);
    for (const lot of lots) {
      for (const b of await getLotBuilds(pool, lot)) touched.add(buildHref(b.sha256, b.name));
    }
  }
  for (const path of touched) {
    revalidatePath(path);
    revalidatePath(`${path}/assets`);
  }
  return Response.json({ sha256, name: fields.name ?? prev.name, lot: fields.lot !== undefined ? fields.lot : prev.lot });
}
