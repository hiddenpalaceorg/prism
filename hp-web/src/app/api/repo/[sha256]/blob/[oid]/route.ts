import type { NextRequest } from "next/server";
import { blobSize, openBlobStream } from "@/lib/blobstore";
import { IMMUTABLE_CACHE, SANDBOX_CSP, contentDisposition, streamResponse } from "@/lib/http";
import { parseRange } from "@/lib/range";
import { loadRepo, repoAttached } from "@/lib/repo";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/repo/<manifest sha256>/blob/<git blob oid>[?name=<basename hint>]
// — stream one file version of an attached repo from the blob store. The oid
// must be referenced by the manifest (which itself must be attached to a
// build), so this can't serve arbitrary store content. A blob can live at
// many paths, so the download filename comes from the ?name hint.
//
// Headers mirror /api/asset: repo blobs are only ever text/plain (inline) or
// opaque bytes (attachment), never anything a browser could script with.

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ sha256: string; oid: string }> }
) {
  const { sha256, oid } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  if (!/^[0-9a-f]{40}$/.test(oid)) return Response.json({ error: "invalid oid" }, { status: 400 });
  if (!(await repoAttached(sha256))) return Response.json({ error: "not found" }, { status: 404 });
  const idx = await loadRepo(sha256);
  if (!idx) return Response.json({ error: "repository data not in store" }, { status: 404 });

  const info = idx.blobs.get(oid);
  if (!info) return Response.json({ error: "not found" }, { status: 404 });
  const [storeSha, , binary] = info;

  if (request.headers.get("if-none-match") === `"${oid}"`) {
    return new Response(null, { status: 304, headers: { "Cache-Control": IMMUTABLE_CACHE, ETag: `"${oid}"` } });
  }

  const size = await blobSize(storeSha);
  if (size === null) {
    // Row + manifest landed but this blob hasn't synced to this store yet.
    return Response.json({ error: "blob bytes not in store" }, { status: 404 });
  }

  const name = request.nextUrl.searchParams.get("name") || oid;
  const headers: Record<string, string> = {
    "Content-Type": binary ? "application/octet-stream" : "text/plain; charset=utf-8",
    "Content-Disposition": contentDisposition(name, !binary),
    "Cache-Control": IMMUTABLE_CACHE,
    ETag: `"${oid}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": SANDBOX_CSP,
    "Accept-Ranges": "bytes",
  };

  const range = parseRange(request.headers.get("range"), size);
  const stream = await openBlobStream(storeSha, range ?? undefined);
  if (!stream) return Response.json({ error: "blob bytes not in store" }, { status: 404 });
  return streamResponse(stream, size, range, headers);
}
