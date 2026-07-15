import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { getBuildAssets } from "@/lib/queries";
import { assetTotals, orderAssets, readAssetExcerpt } from "@/lib/assets";
import AssetGallery from "../AssetGallery";

export const runtime = "nodejs";
// Same ISR shape as the build page: the corpus only changes at ingest.
export const revalidate = 3600;
export function generateStaticParams(): Array<{ sha256: string }> {
  return [];
}

// Excerpt reads are tiny (2KB head per file) but keep them bounded on builds
// with pathological text counts; cards past the cap still open in the viewer.
const MAX_EXCERPT_READS = 200;

export default async function BuildAssetsPage({ params }: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await params;
  const pool = getPool();
  // Name only — the build page's full record (MBs of jsonb) isn't needed here.
  const [nameRes, assets] = await Promise.all([
    pool.query("SELECT name, system FROM builds WHERE sha256=$1", [sha256]),
    getBuildAssets(pool, sha256),
  ]);
  const build = nameRes.rows[0] as { name: string; system: string } | undefined;
  if (!build) notFound();

  const ordered = orderAssets(assets);
  const excerpts = Object.fromEntries(
    await Promise.all(
      ordered
        .filter((a) => a.kind === "source" || a.kind === "text")
        .slice(0, MAX_EXCERPT_READS)
        .map(async (a) => [a.path, (await readAssetExcerpt(a.sha256)) ?? ""] as const)
    )
  );

  return (
    <main className="mx-auto max-w-none px-4 py-10 sm:px-8">
      <Link href={`/builds/${sha256}`} className="text-sm text-neutral-500 hover:underline">
        &larr; {build.name}
      </Link>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        Assets <span className="text-base font-normal text-neutral-400">({assets.length})</span>
      </h1>

      <section className="mt-4">
        <AssetGallery sha256={sha256} assets={ordered} totals={assetTotals(assets)} excerpts={excerpts} />
      </section>
    </main>
  );
}
