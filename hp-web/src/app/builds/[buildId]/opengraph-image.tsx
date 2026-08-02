// Social-preview card for a build (og:image / twitter:image), rendered with
// satori via next/og. Next's file convention wires it into <meta> for this
// segment and everything below it, so asset deep links inherit it too.
//
// Dark info card: wordmark, title, fact chips, short id — plus an image row.
// The row shows up to four images: front physical media first, then one insert
// (other physical media), then PNG/JPEG/BMP/TGA/TIFF assets. Back media is omitted.

import fsp from "node:fs/promises";
import { ImageResponse } from "next/og";
import { readBlob } from "@/lib/blobstore";
import {
  selectBuildOgImages,
  type BuildOgMediaImage,
} from "@/lib/build-og";
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
// pushing through satori for a social-preview pane.
const PHOTO_DIRECT_MAX_BYTES = 1_000_000;

interface MediaImageRow {
  sha256: string;
  content_type: string;
  size: number;
  label: string | null;
}

async function loadMediaThumbnail(sha256: string): Promise<string | null> {
  try {
    const base = process.env.SITE_URL ?? "https://hiddenpalace.org";
    const url = new URL(`/api/media/${sha256}/thumb?w=500`, base);
    const response = await fetch(url, { cache: "force-cache" });
    const contentType = response.headers.get("content-type");
    if (!response.ok || !contentType?.startsWith("image/")) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

// Oversized photos (and webp, which the card renderer can't decode) are served
// as 500px JPEGs via ffmpeg: twice the rendered grid-cell width. If direct
// storage access fails, use the same thumbnail route that serves the build page.
async function loadMediaImage(row: MediaImageRow): Promise<string | null> {
  try {
    if (row.size > PHOTO_DIRECT_MAX_BYTES || row.content_type === "image/webp") {
      const scaled = await ensurePhotoScale(row.sha256, MEDIA_NS, 500);
      const bytes = await fsp.readFile(scaled);
      return `data:image/jpeg;base64,${bytes.toString("base64")}`;
    }
    const bytes = await readBlob(row.sha256, MEDIA_NS);
    if (bytes !== null) {
      return `data:${row.content_type};base64,${bytes.toString("base64")}`;
    }
  } catch {
    // Fall through to the public thumbnail path.
  }
  return loadMediaThumbnail(row.sha256);
}

async function findMediaImages(sha256: string): Promise<BuildOgMediaImage<string>[]> {
  const r = await getPool().query(
    `SELECT sha256, content_type, size::float8 AS size, label FROM build_media
     WHERE build_sha256=$1 AND kind='physical'
       AND label IS DISTINCT FROM 'back'
       AND content_type IN ('image/png','image/jpeg','image/gif','image/webp')
     ORDER BY (label IS NOT DISTINCT FROM 'front') DESC, created_at, id LIMIT 16`,
    [sha256]
  );

  const rows = r.rows as MediaImageRow[];
  const images: BuildOgMediaImage<string>[] = [];
  for (const row of rows.filter(({ label }) => label === "front")) {
    const image = await loadMediaImage(row);
    if (image) images.push({ image, label: "front" });
    if (images.length === 4) return images;
  }

  for (const row of rows.filter(({ label }) => label !== "front")) {
    const image = await loadMediaImage(row);
    if (image) {
      images.push({ image, label: row.label });
      break;
    }
  }
  return images;
}

async function findAssetPictures(sha256: string, limit: number): Promise<string[]> {
  if (limit <= 0) return [];

  const r = await getPool().query(
    `SELECT sha256, mime FROM build_asset
     WHERE build_sha256=$1 AND kind='image'
       AND mime IN ('image/png','image/jpeg','image/bmp','image/x-tga','image/tiff')
       AND size <= $2
     ORDER BY size DESC LIMIT $3`,
    [sha256, MAX_SHOT_BYTES, Math.max(4, limit * 4)]
  );
  // A row's blob can be missing (metadata ingested before the bundle carrying
  // the bytes) or undecodable — fall through to the next-largest candidate.
  const images: string[] = [];
  for (const row of r.rows as Array<{ sha256: string; mime: string }>) {
    try {
      const bytes = await readBlob(row.sha256);
      if (bytes === null) continue;
      // satori can't decode BMP or TGA — hand it PNG bytes instead.
      if (pngConvertible(row.mime)) {
        images.push(`data:image/png;base64,${toPng(row.mime, bytes).toString("base64")}`);
      } else {
        images.push(`data:${row.mime};base64,${bytes.toString("base64")}`);
      }
      if (images.length === limit) break;
    } catch {
      continue;
    }
  }
  return images;
}

function Card({ meta, shots }: { meta: BuildMetaRow; shots: string[] }) {
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
      {shots.length > 0 && (
        <div
          style={{
            width: shots.length === 1 ? 480 : 630,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            alignContent: "center",
            gap: 12,
            background: "#171717",
            borderLeft: "1px solid #262626",
            padding: 24,
          }}
        >
          {/* Priority order is row-major, keeping front/sleeve media top-left. */}
          {shots.map((shot, index) => (
            <div
              key={index}
              style={{
                display: "flex",
                // Do not let the image's intrinsic width force a one-column grid.
                flexGrow: 0,
                flexShrink: 0,
                minWidth: 0,
                minHeight: 0,
                width: shots.length === 1 ? "100%" : 285,
                height: shots.length === 1 ? "100%" : 285,
                overflow: "hidden",
              }}
            >
              <img
                src={shot}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: 12 }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Materialize the PNG so satori failures (e.g. an undecodable blob) are
// catchable — then retry without images instead of 500ing the unfurl.
async function render(meta: BuildMetaRow, shots: string[]): Promise<Response> {
  const img = new ImageResponse(<Card meta={meta} shots={shots} />, size);
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

  const media = await findMediaImages(meta.sha256);
  const mediaImages = selectBuildOgImages(media, []);
  const assets = await findAssetPictures(meta.sha256, 4 - mediaImages.length);
  const shots = selectBuildOgImages(media, assets);
  try {
    return await render(meta, shots);
  } catch {
    return await render(meta, []);
  }
}
