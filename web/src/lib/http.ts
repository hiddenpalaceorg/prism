// Shared HTTP-layer helpers for the byte-serving routes (asset, media, repo
// blob, audio/video transcodes). These were copy-pasted per route and had begun
// to drift — a single source keeps the cache/CSP contract and the range/stream
// plumbing identical everywhere.

import { Readable } from "node:stream";

/** Content-addressed responses never change — cache for a year, immutable. */
export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

/** Locked-down CSP for served blobs: no scripts, sandboxed, inline styles only
 *  (SVG/PDF viewers). Applied with X-Content-Type-Options: nosniff. */
export const SANDBOX_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** PDFs render in the browser's PDF viewer, which `sandbox` blocks (Chrome
 *  treats a sandboxed response as plugin-forbidden and downloads instead).
 *  Dropping the directive is safe for this type only: with nosniff the response
 *  can never be reinterpreted as HTML, and script inside a PDF runs in the
 *  viewer's isolated world, not against this origin. */
export const PDF_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/** A Content-Disposition value with the filename collapsed to a quoted ASCII
 *  form (non-ASCII and quote/backslash → underscore), so a hostile stored path
 *  can't break out of the header. */
export function contentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"`;
}

/** Build the streaming Response for a (possibly ranged) blob read: 206 with
 *  Content-Range when `range` is set, else 200, adding Content-Length either
 *  way. `headers` is the fully-assembled base set (content-type, cache, CSP,
 *  Accept-Ranges, ETag …); the caller opens `stream` for the same range. */
export function streamResponse(
  stream: Readable,
  size: number,
  range: { start: number; end: number } | null,
  headers: Record<string, string>
): Response {
  const web = Readable.toWeb(stream) as ReadableStream;
  if (range) {
    return new Response(web, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(range.end - range.start + 1),
      },
    });
  }
  return new Response(web, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
}
