import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import type { Pool } from "pg";
import { getPool } from "@/lib/db";
import { getBuildAssets, resolveBuild, type BuildAsset } from "@/lib/queries";
import { assetExcerpts, assetTotals, orderAssets } from "@/lib/assets";
import { gsAvailable, gsRenderable } from "@/lib/gs";
import { pngConvertible, WEB_SAFE_IMAGE } from "@/lib/imgpng";
import { psdConvertible } from "@/lib/psd";
import { humanSize } from "@/lib/meta";
import { canonicalBuildId, parseBuildParam, safeDecodeSegment } from "@/lib/slug";
import AssetGallery from "../../AssetGallery";
import AssetViewerHost from "../../AssetViewerHost";

export const runtime = "nodejs";
// Same ISR shape as the build page: the corpus only changes at ingest.
export const revalidate = 3600;
export function generateStaticParams(): Array<{ buildId: string; path: string[] }> {
  return [];
}

// Excerpt reads are tiny (2KB head per file) but keep them bounded on builds
// with pathological text counts; cards past the cap still open in the viewer.
const MAX_EXCERPT_READS = 200;

// Stored asset paths carry a leading "/" that URL segments drop.
async function findAsset(pool: Pool, buildSha: string, relPath: string): Promise<BuildAsset | null> {
  const r = await pool.query(
    `SELECT path, sha256, size::float8 AS size, mime, kind FROM build_asset
     WHERE build_sha256=$1 AND (path=$2 OR path='/'||$2) LIMIT 1`,
    [buildSha, relPath]
  );
  return (r.rows[0] as BuildAsset) ?? null;
}

// Unfurl metadata: the gallery inherits the build's card; a deep-linked asset
// gets its file name as the title, and image assets unfurl as the image itself.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ buildId: string; path?: string[] }>;
}): Promise<Metadata> {
  const { buildId, path } = await params;
  const parsed = parseBuildParam(buildId);
  if (!parsed) return {};
  const pool = getPool();
  const resolved = await resolveBuild(pool, parsed.hex, parsed.slug);
  if (!resolved) return {};
  const href = `/builds/${canonicalBuildId(resolved.sha256, resolved.name)}`;

  // The build's generated card (see ../opengraph-image.tsx). Referenced
  // explicitly: the file convention doesn't cascade into this nested segment.
  const card = `${href}/opengraph-image`;

  const relPath = (path ?? []).map(safeDecodeSegment).join("/");
  const asset = relPath ? await findAsset(pool, resolved.sha256, relPath) : null;
  if (!asset) {
    const title = `Assets · ${resolved.name}`;
    return {
      title,
      alternates: { canonical: `${href}/assets` },
      openGraph: { title, url: `${href}/assets`, siteName: "Hidden Palace", images: [card] },
      twitter: { card: "summary_large_image" },
    };
  }

  const name = asset.path.split("/").pop() || asset.path;
  const description = `${resolved.name} · ${humanSize(asset.size)} · ${asset.mime}`;
  return {
    title: name,
    description,
    alternates: { canonical: `${href}/assets/${relPath.split("/").map(encodeURIComponent).join("/")}` },
    openGraph: {
      title: name,
      description,
      siteName: "Hidden Palace",
      // Image assets unfurl as themselves — directly when the format is
      // web-safe, via PNG conversion when it isn't (BMP/TGA/TIFF, flattened
      // PSD). Documents unfurl as their rasterized first page/artwork when
      // the server has Ghostscript; everything else (audio/video/text,
      // ico/svg) gets the build card.
      images: [
        asset.kind === "image" && WEB_SAFE_IMAGE.test(asset.mime)
          ? `/api/asset/${asset.sha256}`
          : asset.kind === "image" && (pngConvertible(asset.mime) || psdConvertible(asset.mime))
            ? `/api/asset/${asset.sha256}/png`
            : asset.kind === "document" && gsRenderable(asset.mime) && (await gsAvailable())
              ? `/api/asset/${asset.sha256}/png`
              : card,
      ],
    },
    twitter: { card: "summary_large_image" },
  };
}

// /builds/<id>/assets — the full gallery; /builds/<id>/assets/<path…> — the
// same gallery with the viewer open on that file (the URL the lightbox writes).
export default async function BuildAssetsPage({
  params,
}: {
  params: Promise<{ buildId: string; path?: string[] }>;
}) {
  const { buildId, path } = await params;
  const parsed = parseBuildParam(buildId);
  if (!parsed) notFound();
  const pool = getPool();
  const resolved = await resolveBuild(pool, parsed.hex, parsed.slug);
  if (!resolved) notFound();
  const canonical = canonicalBuildId(resolved.sha256, resolved.name);
  const segments = (path ?? []).map(safeDecodeSegment);
  if (buildId !== canonical) {
    const suffix = segments.map(encodeURIComponent).join("/");
    permanentRedirect(`/builds/${canonical}/assets${suffix ? `/${suffix}` : ""}`);
  }
  const sha256 = resolved.sha256;
  const href = `/builds/${canonical}`;

  const assets = await getBuildAssets(pool, sha256);
  const ordered = orderAssets(assets);
  const excerpts = await assetExcerpts(ordered, MAX_EXCERPT_READS);

  // Deep link: open the viewer on the named file. Unknown paths (e.g. a file
  // that exists but isn't viewable) just render the plain gallery.
  const initialPath = segments.length ? segments.join("/") : undefined;

  return (
    <main className="mx-auto max-w-none px-4 py-10 sm:px-8">
      <AssetViewerHost assets={ordered} buildHref={href} returnHref={`${href}/assets`} initialPath={initialPath}>
        <Link href={href} className="text-sm text-neutral-500 hover:underline">
          &larr; {resolved.name}
        </Link>

        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          Assets <span className="text-base font-normal text-neutral-400">({assets.length})</span>
        </h1>

        <section className="mt-4">
          <AssetGallery buildHref={href} assets={ordered} totals={assetTotals(assets)} excerpts={excerpts} />
        </section>
      </AssetViewerHost>
    </main>
  );
}
