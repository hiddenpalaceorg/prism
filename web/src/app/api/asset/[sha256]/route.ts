import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { unstable_cache } from "next/cache";
import { assetBlobPath } from "@/lib/assets";
import { getPool } from "@/lib/db";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/asset/<sha256> — stream one viewable asset from the blob store.
//
// The URL is content-addressed, so a response never changes: cache hard.
const CACHE = "public, max-age=31536000, immutable";

// Defense against a hostile mime smuggled in through the submissions API: only
// media types and bare text/plain are ever served inline. text/html (or
// anything else surprising) becomes a plain download instead of a document
// that could script against this origin. The CSP sandbox below backstops even
// the inline types (e.g. SVG's script capability when opened as a document).
function servableMime(mime: string): boolean {
  return mime === "text/plain" || /^(image|audio|video)\/[\w.+-]+$/.test(mime);
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

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

export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const meta = await getMeta(sha256);
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });

  // The browser already holds an immutable copy — never re-send the bytes.
  if (request.headers.get("if-none-match") === `"${sha256}"`) {
    return new Response(null, { status: 304, headers: { "Cache-Control": CACHE, ETag: `"${sha256}"` } });
  }

  const blob = assetBlobPath(sha256);
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(blob);
  } catch {
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
    "Content-Security-Policy": CSP,
    "Accept-Ranges": "bytes",
  };

  // Single-range support so <audio>/<video> can seek.
  const range = parseRange(request.headers.get("range"), stat.size);
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    const stream = fs.createReadStream(blob, { start: range.start, end: range.end });
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers });
  }

  headers["Content-Length"] = String(stat.size);
  const stream = fs.createReadStream(blob);
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
}
