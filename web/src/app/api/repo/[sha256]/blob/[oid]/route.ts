import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { blobSize, openBlobStream } from "@/lib/blobstore";
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
const CACHE = "public, max-age=31536000, immutable";
const CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** One satisfiable `bytes=start-end` range, else null (serve the whole file). */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || size === 0) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  const start = a === "" ? Math.max(0, size - Number(b)) : Number(a);
  const end = a !== "" && b !== "" ? Math.min(Number(b), size - 1) : size - 1;
  if (start > end || start >= size) return null;
  return { start, end };
}

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
    return new Response(null, { status: 304, headers: { "Cache-Control": CACHE, ETag: `"${oid}"` } });
  }

  const size = await blobSize(storeSha);
  if (size === null) {
    // Row + manifest landed but this blob hasn't synced to this store yet.
    return Response.json({ error: "blob bytes not in store" }, { status: 404 });
  }

  const name = request.nextUrl.searchParams.get("name") || oid;
  const asciiName = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const headers: Record<string, string> = {
    "Content-Type": binary ? "application/octet-stream" : "text/plain; charset=utf-8",
    "Content-Disposition": `${binary ? "attachment" : "inline"}; filename="${asciiName}"`,
    "Cache-Control": CACHE,
    ETag: `"${oid}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": CSP,
    "Accept-Ranges": "bytes",
  };

  const range = parseRange(request.headers.get("range"), size);
  const stream = await openBlobStream(storeSha, range ?? undefined);
  if (!stream) return Response.json({ error: "blob bytes not in store" }, { status: 404 });
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers });
  }

  headers["Content-Length"] = String(size);
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
}
