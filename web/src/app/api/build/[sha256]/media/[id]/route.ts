import type { NextRequest } from "next/server";
import { getContributor, contributionTarget, revalidateBuildPages } from "@/lib/contrib";
import { getPool } from "@/lib/db";
import { deleteMedia, getMediaById } from "@/lib/media";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /api/build/<sha256>/media/<id>: remove one media entry, by its own
// author or a moderator. The blob stays in the store (content-addressed and
// possibly shared); only the record goes.
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ sha256: string; id: string }> }) {
  const { sha256, id } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  const mediaId = Number(id);
  if (!Number.isInteger(mediaId) || mediaId <= 0) {
    return Response.json({ error: "invalid id" }, { status: 400 });
  }

  const contributor = await getContributor(request);
  if (!contributor) return Response.json({ error: "log in to the wiki first" }, { status: 401 });
  const pool = getPool();
  const target = await contributionTarget(pool, sha256);
  if (!target) return Response.json({ error: "not found" }, { status: 404 });

  const row = await getMediaById(pool, sha256, mediaId);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  if (row.author !== contributor.name && !contributor.moderator) {
    return Response.json({ error: "only the uploader or a moderator can remove this" }, { status: 403 });
  }

  await deleteMedia(pool, sha256, mediaId);
  revalidateBuildPages(sha256, target.name);
  return Response.json({ deleted: true });
}
