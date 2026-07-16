import { getPool } from "@/lib/db";
import { ensureTranscode, transcodable, transcodeStatus } from "@/lib/ffmpeg";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/asset/<sha256>/video/status — where this asset's transcode stands:
// {state: "ready" | "transcoding" | "failed"}, with a best-effort integer
// `percent` while transcoding. The player polls this after ../video answers
// 202 (or after a server restart orphaned its wait). When nothing is running
// or cached, this kicks the transcode off — the poll loop stays a plain
// repeat-until-ready on one URL.

export async function GET(_request: Request, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const r = await getPool().query("SELECT mime FROM build_asset WHERE sha256=$1 LIMIT 1", [sha256]);
  const meta = r.rows[0] as { mime: string } | undefined;
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });

  const headers = { "Cache-Control": "no-store" };
  // Natively playable formats have no transcode; the raw asset is the stream.
  if (meta.mime === "video/mp4" || meta.mime === "video/webm") {
    return Response.json({ state: "ready" }, { headers });
  }
  if (!transcodable(meta.mime)) {
    return Response.json({ error: `no video transcode for ${meta.mime}` }, { status: 415 });
  }

  const status = await transcodeStatus(sha256);
  if (status.state === "ready") return Response.json({ state: "ready" }, { headers });
  if (status.state === "transcoding") {
    return Response.json({ state: "transcoding", percent: status.percent }, { headers });
  }
  if (status.state === "failed") return Response.json({ state: "failed" }, { headers });

  // Nothing cached, running, or failed — start it (a restart may have lost an
  // in-flight job) and report the fresh run. Errors surface on later polls.
  ensureTranscode(sha256).catch(() => {});
  return Response.json({ state: "transcoding", percent: null }, { headers });
}
