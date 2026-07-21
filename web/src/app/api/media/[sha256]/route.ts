import type { NextRequest } from "next/server";
import { blobSize, openBlobStream } from "@/lib/blobstore";
import { getPool } from "@/lib/db";
import { IMMUTABLE_CACHE, SANDBOX_CSP, streamResponse } from "@/lib/http";
import { MEDIA_NS, mediaContentType } from "@/lib/media";
import { parseRange } from "@/lib/range";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

// GET /api/media/<sha256>: stream one user-media blob (or a video poster)
// out of the media/ namespace. In production the pages link the public bucket
// gateway instead; this route is the fallback when no gateway is configured
// (dev, or a fresh deployment). Content-addressed, so responses cache hard.
export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const contentType = await mediaContentType(getPool(), sha256);
  if (!contentType) return Response.json({ error: "not found" }, { status: 404 });

  if (request.headers.get("if-none-match") === `"${sha256}-media"`) {
    return new Response(null, { status: 304, headers: { "Cache-Control": IMMUTABLE_CACHE, ETag: `"${sha256}-media"` } });
  }

  const size = await blobSize(sha256, MEDIA_NS);
  if (size == null) return Response.json({ error: "blob missing from store" }, { status: 404 });

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": `inline; filename="${sha256.slice(0, 12)}.${EXT[contentType] ?? "bin"}"`,
    "Cache-Control": IMMUTABLE_CACHE,
    ETag: `"${sha256}-media"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": SANDBOX_CSP,
    "Accept-Ranges": "bytes",
  };

  // Single-range support so <video> can seek.
  const range = parseRange(request.headers.get("range"), size);
  const stream = await openBlobStream(sha256, range ?? undefined, MEDIA_NS);
  if (!stream) return Response.json({ error: "blob missing from store" }, { status: 404 });
  return streamResponse(stream, size, range, headers);
}
