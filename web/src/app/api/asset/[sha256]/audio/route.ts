import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { readBlobHead } from "@/lib/blobstore";
import { getPool } from "@/lib/db";
import { ensureAudioTranscode } from "@/lib/ffmpeg";
import { parseRange } from "@/lib/range";
import { isSha256 } from "@/lib/validate";
import { wavBrowserPlayable } from "@/lib/wav";

export const runtime = "nodejs";

// GET /api/asset/<sha256>/audio — where <audio> should stream a WAV from.
// Console builds carry WAVs whose codec is an ADPCM variant browsers won't
// decode (e.g. Xbox ADPCM, format tag 0x0069). The extractor stamps them all
// audio/wav, so the codec check reads the fmt chunk from the blob itself.
// Natively playable WAVs (PCM, float, A-law, µ-law) redirect to the raw asset
// route, keeping one copy in the browser cache. The rest are transcoded once
// to 16-bit PCM WAV, cached on disk, and streamed with Range support. The URL
// is content-addressed, so responses cache hard.

const CACHE = "public, max-age=31536000, immutable";
const CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const r = await getPool().query(
    "SELECT path, mime FROM build_asset WHERE sha256=$1 LIMIT 1",
    [sha256]
  );
  const meta = r.rows[0] as { path: string; mime: string } | undefined;
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });

  if (meta.mime !== "audio/wav") {
    // Only WAV hides its codec behind one mime; every other audio format we
    // extract plays as-is.
    return /^audio\//.test(meta.mime)
      ? Response.redirect(new URL(`/api/asset/${sha256}`, request.url), 308)
      : Response.json({ error: `no audio transcode for ${meta.mime}` }, { status: 415 });
  }

  // The browser already holds an immutable copy of the transcode (this ETag
  // is only ever set on transcoded responses): never re-send the bytes.
  if (request.headers.get("if-none-match") === `"${sha256}-audio"`) {
    return new Response(null, {
      status: 304,
      headers: { "Cache-Control": CACHE, ETag: `"${sha256}-audio"` },
    });
  }

  const head = await readBlobHead(sha256);
  if (head === null) return Response.json({ error: "asset bytes not in store" }, { status: 404 });
  if (wavBrowserPlayable(head)) {
    return Response.redirect(new URL(`/api/asset/${sha256}`, request.url), 308);
  }

  // No soft-wait/202 dance like video: ADPCM to PCM runs far faster than
  // real time, so even the biggest WAVs in the corpus finish within the
  // request.
  let audioPath: string;
  try {
    audioPath = await ensureAudioTranscode(sha256);
  } catch {
    // No usable ffmpeg, blob missing from the store, or ffmpeg rejected or
    // timed out on the input.
    return Response.json({ error: "untranscodable audio" }, { status: 415 });
  }
  const stat = await fsp.stat(audioPath);

  const name = meta.path.split("/").pop() || `${sha256}.wav`;
  const asciiName = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const headers: Record<string, string> = {
    "Content-Type": "audio/wav",
    "Content-Disposition": `inline; filename="${asciiName}"`,
    "Cache-Control": CACHE,
    ETag: `"${sha256}-audio"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": CSP,
    "Accept-Ranges": "bytes",
  };

  // Single-range support so <audio> can seek.
  const range = parseRange(request.headers.get("range"), stat.size);
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
    const stream = fs.createReadStream(audioPath, { start: range.start, end: range.end });
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers });
  }

  headers["Content-Length"] = String(stat.size);
  const stream = fs.createReadStream(audioPath);
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
}
