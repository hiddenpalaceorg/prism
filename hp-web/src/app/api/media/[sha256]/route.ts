import type { NextRequest } from "next/server";
import { blobSize, openBlobStream } from "@/lib/blobstore";
import { getPool } from "@/lib/db";
import { contentDisposition, IMMUTABLE_CACHE, SANDBOX_CSP, streamResponse } from "@/lib/http";
import { MEDIA_NS, mediaBlobInfo } from "@/lib/media";
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

  const info = await mediaBlobInfo(getPool(), sha256);
  if (!info) return Response.json({ error: "not found" }, { status: 404 });
  const { contentType } = info;

  if (request.headers.get("if-none-match") === `"${sha256}-media"`) {
    return new Response(null, { status: 304, headers: { "Cache-Control": IMMUTABLE_CACHE, ETag: `"${sha256}-media"` } });
  }

  const size = await blobSize(sha256, MEDIA_NS);
  if (size == null) return Response.json({ error: "blob missing from store" }, { status: 404 });

  // Saving from here keeps the uploader's own filename. The pages draw media
  // from the bucket gateway, which only knows the hash, so this route is what
  // the viewer's Download link points at.
  const name = info.filename || `${sha256.slice(0, 12)}.${EXT[contentType] ?? "bin"}`;

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": contentDisposition(name, true),
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
