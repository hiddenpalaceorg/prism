import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { getBuildAssets, resolveBuild } from "@/lib/queries";
import { assetTotals, orderAssets, readAssetExcerpt } from "@/lib/assets";
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
  const excerpts = Object.fromEntries(
    await Promise.all(
      ordered
        .filter((a) => a.kind === "source" || a.kind === "text")
        .slice(0, MAX_EXCERPT_READS)
        .map(async (a) => [a.path, (await readAssetExcerpt(a.sha256)) ?? ""] as const)
    )
  );

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
