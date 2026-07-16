import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { ensureThumb } from "@/lib/ffmpeg";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/asset/<sha256>/thumb — a poster still (JPEG) pulled out of a video
// asset, for gallery cards and <video poster>. Produced by ffmpeg on first
// use and cached in the store under .thumb/. The URL is content-addressed, so
// responses cache hard; clients treat a failure (no ffmpeg on the server, or
// a stream with no decodable frame) as "no poster" and degrade.

const CACHE = "public, max-age=31536000, immutable";
const CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const r = await getPool().query(
    "SELECT mime FROM build_asset WHERE sha256=$1 LIMIT 1",
    [sha256]
  );
  const meta = r.rows[0] as { mime: string } | undefined;
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });
  if (!meta.mime.startsWith("video/")) {
    return Response.json({ error: `no thumbnail for ${meta.mime}` }, { status: 415 });
  }

  // The browser already holds an immutable copy: never re-send the bytes.
  if (request.headers.get("if-none-match") === `"${sha256}-thumb"`) {
    return new Response(null, {
      status: 304,
      headers: { "Cache-Control": CACHE, ETag: `"${sha256}-thumb"` },
    });
  }

  let thumb: string;
  try {
    thumb = await ensureThumb(sha256);
  } catch {
    // No usable ffmpeg, blob missing from the store, or no decodable frame.
    return Response.json({ error: "no thumbnail" }, { status: 415 });
  }
  const stat = await fsp.stat(thumb);
  const stream = fs.createReadStream(thumb);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(stat.size),
      "Cache-Control": CACHE,
      ETag: `"${sha256}-thumb"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": CSP,
    },
  });
}
