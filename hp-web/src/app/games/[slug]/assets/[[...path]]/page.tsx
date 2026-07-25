import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getModeratorFromHeaders } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { getGameAssets, getGameBySlug } from "@/lib/queries";
import { assetExcerpts, assetMonths, assetTotals, orderAssets } from "@/lib/assets";
import { safeDecodeSegment } from "@/lib/slug";
import AssetGallery from "../../../../builds/[buildId]/AssetGallery";
import AssetViewerHost from "../../../../builds/[buildId]/AssetViewerHost";

export const runtime = "nodejs";
// Same shape as the game page: assignments change through moderation, so
// render fresh (the asset set itself only changes at ingest).
export const dynamic = "force-dynamic";

// Excerpt reads are tiny (2KB head per file) but keep them bounded on games
// whose builds carry pathological text counts.
const MAX_EXCERPT_READS = 200;
// At most this many items per kind per month, matching the game page; the
// rare overflow (a 200+ image month) stays reachable on each build's page.
const MONTH_PER_KIND = 200;

interface Params {
  params: Promise<{ slug: string; path?: string[] }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, path } = await params;
  const game = await getGameBySlug(getPool(), decodeURIComponent(slug));
  if (!game) return {};
  const relPath = (path ?? []).map(safeDecodeSegment).join("/");
  const name = relPath.split("/").pop();
  return { title: name || `Assets · ${game.name}` };
}

// /games/<slug>/assets — the full combined gallery over every visible build
// of the game; /games/<slug>/assets/<build name>/<path…> — the same gallery
// with the viewer open on that file (the URL the lightbox writes).
export default async function GameAssetsPage({ params }: Params) {
  const { slug, path } = await params;
  const pool = getPool();
  const game = await getGameBySlug(pool, decodeURIComponent(slug));
  if (!game) notFound();
  const href = `/games/${game.slug}`;

  // Per-request render: wiki-moderators see private builds' assets too,
  // matching the game page itself.
  const includePrivate = !!(await getModeratorFromHeaders(await headers()));
  const assets = await getGameAssets(pool, game.id, includePrivate);
  // Same month timeline as the game page.
  const months = assetMonths(assets).map((m) => ({
    ...m,
    ordered: orderAssets(m.assets, MONTH_PER_KIND),
    totals: assetTotals(m.assets),
  }));
  const ordered = months.flatMap((m) => m.ordered);
  const excerpts = await assetExcerpts(ordered, MAX_EXCERPT_READS);

  // Deep link: open the viewer on the named file; unknown paths just render
  // the plain gallery.
  const segments = (path ?? []).map(safeDecodeSegment);
  const initialPath = segments.length ? segments.join("/") : undefined;

  return (
    <main className="mx-auto max-w-none px-4 py-10 sm:px-8">
      <AssetViewerHost assets={ordered} buildHref={href} returnHref={`${href}/assets`} initialPath={initialPath}>
        <Link href={href} className="text-sm text-neutral-500 hover:underline">
          &larr; {game.system ? `${game.name} (${game.system})` : game.name}
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Assets</h1>
        <p className="mt-1 text-xs text-neutral-500">
          Extracted from every build of {game.name}; the path prefix names the build each file came from.
        </p>
        {assets.length === 0 ? (
          <p className="mt-6 text-sm text-neutral-500">No viewable assets in this game&apos;s builds.</p>
        ) : (
          months.map((m) => (
            <div key={m.key} className="mt-8 first:mt-4">
              {/* Sticky per-month header, same treatment as the game page. */}
              <h3 className="sticky top-0 z-10 border-b border-neutral-200 bg-[var(--background)] pb-1 pt-2 text-sm font-semibold dark:border-neutral-800">
                {m.label}
                <span className="ml-2 font-normal text-neutral-400">
                  {m.assets.length} {m.assets.length === 1 ? "file" : "files"}
                </span>
              </h3>
              <AssetGallery buildHref={href} assets={m.ordered} totals={m.totals} excerpts={excerpts} />
            </div>
          ))
        )}
      </AssetViewerHost>
    </main>
  );
}
