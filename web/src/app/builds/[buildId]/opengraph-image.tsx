// Social-preview card for a build (og:image / twitter:image), rendered with
// satori via next/og. Next's file convention wires it into <meta> for this
// segment and everything below it, so asset deep links inherit it too.
//
// Dark info card: wordmark, title, fact chips, short id — plus an image pane.
// A physical-media photo labeled "front" wins (first by upload order); without
// one the pane shows a PNG/JPEG/BMP/TGA/TIFF asset whose bytes are in the blob
// store (largest first: big files are screenshots, tiny ones are icons/textures).

import fsp from "node:fs/promises";
import { ImageResponse } from "next/og";
import { readBlob } from "@/lib/blobstore";
import { getPool } from "@/lib/db";
import { ensurePhotoScale } from "@/lib/ffmpeg";
import { pngConvertible, toPng } from "@/lib/imgpng";
import { MEDIA_NS } from "@/lib/media";
import { buildFacts, displayTitle } from "@/lib/meta";
import { getBuildMeta, resolveBuild, type BuildMetaRow } from "@/lib/queries";
import { parseBuildParam, SHORT_SHA_LEN } from "@/lib/slug";

export const runtime = "nodejs";
export const alt = "Build summary card";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Satori decodes the screenshot in-process — skip pathological blobs.
const MAX_SHOT_BYTES = 8_000_000;

// Photos over this go through the cached ffmpeg downscale instead of being
// inlined whole — camera shots and scans routinely blow past what's worth
// pushing through satori for a 480px pane.
const PHOTO_DIRECT_MAX_BYTES = 1_000_000;

// The first front-labeled photo in upload order, else the first physical
// photo of any label — a contributed photo identifies the build better than
// the largest-asset heuristic, and far better than an imageless card.
// Oversized photos (and webp, which the card renderer can't decode) are
// served as scaled JPEGs via ffmpeg; a candidate that can't be served falls
// through to the next, then to findScreenshot.
async function findFrontPhoto(sha256: string): Promise<string | null> {
  const r = await getPool().query(
    `SELECT sha256, content_type, size::float8 AS size FROM build_media
     WHERE build_sha256=$1 AND kind='physical'
       AND content_type IN ('image/png','image/jpeg','image/gif','image/webp')
     ORDER BY (label IS NOT DISTINCT FROM 'front') DESC, created_at, id LIMIT 4`,
    [sha256]
  );
  for (const row of r.rows as Array<{ sha256: string; content_type: string; size: number }>) {
    try {
      if (row.size > PHOTO_DIRECT_MAX_BYTES || row.content_type === "image/webp") {
        const scaled = await ensurePhotoScale(row.sha256, MEDIA_NS);
        const bytes = await fsp.readFile(scaled);
        return `data:image/jpeg;base64,${bytes.toString("base64")}`;
      }
      const bytes = await readBlob(row.sha256, MEDIA_NS);
      if (bytes === null) continue;
      return `data:${row.content_type};base64,${bytes.toString("base64")}`;
    } catch {
      continue;
    }
  }
  return null;
}

async function findScreenshot(sha256: string): Promise<string | null> {
  const r = await getPool().query(
    `SELECT sha256, mime FROM build_asset
     WHERE build_sha256=$1 AND kind='image'
       AND mime IN ('image/png','image/jpeg','image/bmp','image/x-tga','image/tiff')
       AND size <= $2
     ORDER BY size DESC LIMIT 4`,
    [sha256, MAX_SHOT_BYTES]
  );
  // A row's blob can be missing (metadata ingested before the bundle carrying
  // the bytes) or undecodable — fall through to the next-largest candidate.
  for (const row of r.rows as Array<{ sha256: string; mime: string }>) {
    try {
      const bytes = await readBlob(row.sha256);
      if (bytes === null) continue;
      // satori can't decode BMP or TGA — hand it PNG bytes instead.
      if (pngConvertible(row.mime)) {
        return `data:image/png;base64,${toPng(row.mime, bytes).toString("base64")}`;
      }
      return `data:${row.mime};base64,${bytes.toString("base64")}`;
    } catch {
      continue;
    }
  }
  return null;
}

function Card({ meta, shot }: { meta: BuildMetaRow; shot: string | null }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        background: "#0a0a0a",
        color: "#fafafa",
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 56,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 26, letterSpacing: 6, color: "#737373" }}>HIDDEN PALACE</div>
          <div
            style={{
              marginTop: 30,
              fontSize: 54,
              lineHeight: 1.15,
              lineClamp: 3,
              display: "block",
            }}
          >
            {displayTitle(meta)}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            {buildFacts(meta).map((f) => (
              <div
                key={f}
                style={{
                  border: "1px solid #333333",
                  borderRadius: 10,
                  padding: "8px 20px",
                  fontSize: 27,
                  color: "#d4d4d4",
                }}
              >
                {f}
              </div>
            ))}
          </div>
          {/* One template string: satori treats mixed expression/text as
              multiple children and then demands display:flex. */}
          <div style={{ fontSize: 23, color: "#525252" }}>
            {`${meta.sha256.slice(0, SHORT_SHA_LEN)} · hiddenpalace.org`}
          </div>
        </div>
      </div>
      {shot && (
        <div
          style={{
            width: 480,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#171717",
            borderLeft: "1px solid #262626",
            padding: 24,
          }}
        >
          <img
            src={shot}
            alt=""
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 12 }}
          />
        </div>
      )}
    </div>
  );
}

// Materialize the PNG so satori failures (e.g. an undecodable blob) are
// catchable — then retry without the screenshot instead of 500ing the unfurl.
async function render(meta: BuildMetaRow, shot: string | null): Promise<Response> {
  const img = new ImageResponse(<Card meta={meta} shot={shot} />, size);
  const buf = await img.arrayBuffer();
  return new Response(buf, {
    headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=3600" },
  });
}

export default async function OgImage({ params }: { params: Promise<{ buildId: string }> }) {
  const { buildId } = await params;
  const parsed = parseBuildParam(buildId);
  if (!parsed) return new Response("not found", { status: 404 });
  const pool = getPool();
  const resolved = await resolveBuild(pool, parsed.hex, parsed.slug);
  const meta = resolved && (await getBuildMeta(pool, resolved.sha256));
  if (!meta) return new Response("not found", { status: 404 });

  const shot = (await findFrontPhoto(meta.sha256)) ?? (await findScreenshot(meta.sha256));
  try {
    return await render(meta, shot);
  } catch {
    return await render(meta, null);
  }
}
