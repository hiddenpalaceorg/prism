import type { NextRequest } from "next/server";
import { blobSize, openBlobStream } from "@/lib/blobstore";
import { IMMUTABLE_CACHE, SANDBOX_CSP, streamResponse } from "@/lib/http";
import { MAG_NS, magImageUrl } from "@/lib/mag/store";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/mag/blob/<sha256> — one magazine image blob (page render or
// crop). With a public gateway configured this 307s there (same contract as
// /api/asset); without one it streams from the local store. Serves images
// only: the mag/ namespace also holds source PDFs, which are moderator-only
// and refuse to leave through this route.
export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const size = await blobSize(sha256, MAG_NS);
  if (size === null) return Response.json({ error: "not found" }, { status: 404 });

  const contentType = sniffImage(await headOf(sha256));
  if (!contentType) return Response.json({ error: "not an image" }, { status: 415 });

  const gateway = process.env.ASSET_PUBLIC_BASE;
  if (gateway) {
    // 307 + bounded cache, never 308 (see /api/asset: a cached permanent
    // redirect stranded browsers when the gateway moved hosts).
    return new Response(null, {
      status: 307,
      headers: { Location: magImageUrl(sha256), "Cache-Control": "public, max-age=3600" },
    });
  }

  const etag = `"${sha256}-mag"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { "Cache-Control": IMMUTABLE_CACHE, ETag: etag } });
  }
  const stream = await openBlobStream(sha256, undefined, MAG_NS);
  if (!stream) return Response.json({ error: "not found" }, { status: 404 });
  return streamResponse(stream, size, null, {
    "Content-Type": contentType,
    "Cache-Control": IMMUTABLE_CACHE,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": SANDBOX_CSP,
  });
}

async function headOf(sha256: string): Promise<Buffer | null> {
  const stream = await openBlobStream(sha256, { start: 0, end: 15 }, MAG_NS);
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

function sniffImage(head: Buffer | null): string | null {
  if (!head || head.length < 4) return null;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  return null;
}
