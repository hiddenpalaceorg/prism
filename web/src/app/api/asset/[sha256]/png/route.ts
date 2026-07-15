import { readFile } from "node:fs/promises";
import type { NextRequest } from "next/server";
import { assetBlobPath } from "@/lib/assets";
import { getPool } from "@/lib/db";
import { bmpToPng, pngConvertible, WEB_SAFE_IMAGE } from "@/lib/imgpng";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/asset/<sha256>/png — the asset converted to PNG, for og:image use
// on formats unfurlers won't render (today: BMP). Web-safe formats redirect to
// the raw asset route; content-addressed, so responses cache hard.

const CACHE = "public, max-age=31536000, immutable";

// BMPs are uncompressed; bound what the in-process decoder will chew on.
const MAX_CONVERT_BYTES = 32_000_000;

export async function GET(_request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const r = await getPool().query(
    "SELECT path, mime, size::float8 AS size FROM build_asset WHERE sha256=$1 LIMIT 1",
    [sha256]
  );
  const meta = r.rows[0] as { path: string; mime: string; size: number } | undefined;
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });

  if (WEB_SAFE_IMAGE.test(meta.mime)) {
    return Response.redirect(new URL(`/api/asset/${sha256}`, _request.url), 308);
  }
  if (!pngConvertible(meta.mime) || meta.size > MAX_CONVERT_BYTES) {
    return Response.json({ error: `no PNG conversion for ${meta.mime}` }, { status: 415 });
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(assetBlobPath(sha256));
  } catch {
    return Response.json({ error: "asset bytes not in store" }, { status: 404 });
  }

  let png: Buffer;
  try {
    png = bmpToPng(bytes);
  } catch {
    return Response.json({ error: "undecodable image" }, { status: 415 });
  }

  const base = (meta.path.split("/").pop() || sha256).replace(/\.[^.]*$/, "");
  const asciiName = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": `inline; filename="${asciiName}.png"`,
      "Cache-Control": CACHE,
      ETag: `"${sha256}-png"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
