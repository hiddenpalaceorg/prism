import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { unstable_cache } from "next/cache";
import { publicAssetUrl } from "@/lib/assets";
import { blobSize, openBlobStream } from "@/lib/blobstore";
import { getPool } from "@/lib/db";
import { parseRange } from "@/lib/range";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/asset/<sha256> — stream one viewable asset from the blob store.
//
// The URL is content-addressed, so a response never changes: cache hard.
const CACHE = "public, max-age=31536000, immutable";

// Defense against a hostile mime smuggled in through the submissions API: only
// media types, PDF, and bare text/plain are ever served inline. text/html (or
// anything else surprising) becomes a plain download instead of a document
// that could script against this origin. The CSP sandbox below backstops even
// the inline types (e.g. SVG's script capability when opened as a document).
function servableMime(mime: string): boolean {
  return mime === "text/plain" || mime === "application/pdf" || /^(image|audio|video)\/[\w.+-]+$/.test(mime);
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

// PDFs render in the browser's PDF viewer, which `sandbox` blocks (Chrome
// treats a sandboxed response as plugin-forbidden and downloads instead).
// Dropping the directive is safe for this type only: with nosniff the
// response can never be reinterpreted as HTML, and script inside a PDF runs
// in the viewer's isolated world, not against this origin.
const PDF_CSP = "default-src 'none'; style-src 'unsafe-inline'";

// Asset metadata is immutable for a given content hash — cache the row lookup
// so a screenshot gallery's burst of first-loads costs one query, not N.
const getMeta = unstable_cache(
  async (sha256: string): Promise<{ path: string; mime: string } | null> => {
    const r = await getPool().query(
      "SELECT path, mime FROM build_asset WHERE sha256=$1 LIMIT 1",
      [sha256]
    );
    return (r.rows[0] as { path: string; mime: string }) ?? null;
  },
  ["asset-meta"],
  { revalidate: 3600 }
);

export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const meta = await getMeta(sha256);
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });

  // Media bytes come straight off the public bucket gateway when one is
  // configured — the redirect itself caches as hard as the content would.
  const pub = publicAssetUrl(sha256, meta.mime);
  if (pub) {
    return new Response(null, { status: 308, headers: { Location: pub, "Cache-Control": CACHE } });
  }

  // The browser already holds an immutable copy — never re-send the bytes.
  if (request.headers.get("if-none-match") === `"${sha256}"`) {
    return new Response(null, { status: 304, headers: { "Cache-Control": CACHE, ETag: `"${sha256}"` } });
  }

  const size = await blobSize(sha256);
  if (size === null) {
    // Metadata ingested but the bundle carrying the bytes hasn't landed yet.
    return Response.json({ error: "asset bytes not in store" }, { status: 404 });
  }

  const name = meta.path.split("/").pop() || sha256;
  const asciiName = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const inline = servableMime(meta.mime);
  const headers: Record<string, string> = {
    "Content-Type": inline
      ? meta.mime === "text/plain"
        ? "text/plain; charset=utf-8"
        : meta.mime
      : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"`,
    "Cache-Control": CACHE,
    ETag: `"${sha256}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": meta.mime === "application/pdf" && inline ? PDF_CSP : CSP,
    "Accept-Ranges": "bytes",
  };

  // Single-range support so <audio>/<video> can seek.
  const range = parseRange(request.headers.get("range"), size);
  const stream = await openBlobStream(sha256, range ?? undefined);
  if (!stream) return Response.json({ error: "asset bytes not in store" }, { status: 404 });
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers });
  }

  headers["Content-Length"] = String(size);
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
}
