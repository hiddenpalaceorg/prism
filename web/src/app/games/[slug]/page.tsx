import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getModeratorFromHeaders } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { getGameAssets, getGameBySlug, getGameBuilds } from "@/lib/queries";
import { assetExcerpts, assetTotals, orderAssets } from "@/lib/assets";
import AssetGallery from "../../builds/[buildId]/AssetGallery";
import AssetViewerHost from "../../builds/[buildId]/AssetViewerHost";
import GameBuilds from "./GameBuilds";

// The combined gallery previews at most this many items per kind across all
// of the game's builds; the rest live on /games/<slug>/assets.
const ASSET_PREVIEW_PER_KIND = { image: 30, audio: 20, video: 10, document: 12, source: 10, text: 10, binary: 9 };

export const runtime = "nodejs";
// Assignments change through moderation, not ingest; render fresh each time
// (one indexed query, nowhere near the page budget).
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const game = await getGameBySlug(getPool(), decodeURIComponent(slug));
  if (!game) return {};
  return { title: game.system ? `${game.name} (${game.system})` : game.name };
}

// /games/<slug> — every visible build of one game, oldest first, plus one
// combined asset gallery across all of those builds (paths namespaced by
// build name, so the lightbox shows where each file came from). The slug is
// <name>--<system> (name alone when the system is unknown); private builds
// stay hidden, exactly like the /builds browser.
export default async function GamePage({ params }: Params) {
  const { slug } = await params;
  const pool = getPool();
  const game = await getGameBySlug(pool, decodeURIComponent(slug));
  if (!game) notFound();
  const href = `/games/${game.slug}`;

  // The page renders per-request (force-dynamic), so a wiki-moderator's
  // cookies reveal private builds here — badged, exactly like /builds.
  const includePrivate = !!(await getModeratorFromHeaders(await headers()));
  const [builds, assets] = await Promise.all([
    getGameBuilds(pool, game.id, includePrivate),
    getGameAssets(pool, game.id, includePrivate),
  ]);
  const previewAssets = orderAssets(assets, ASSET_PREVIEW_PER_KIND);
  const excerpts = await assetExcerpts(previewAssets);

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-8">
      <AssetViewerHost assets={orderAssets(assets)} buildHref={href} returnHref={href}>
        <Link href="/builds" className="text-sm text-neutral-500 hover:underline">&larr; All builds</Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{game.name}</h1>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {game.system && (
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
              {game.system}
            </span>
          )}
          <span className="rounded bg-sky-100 px-1.5 py-0.5 font-medium text-sky-900 dark:bg-sky-900/40 dark:text-sky-200">
            {builds.length} {builds.length === 1 ? "build" : "builds"}
          </span>
        </div>

        <GameBuilds builds={builds} />

        {assets.length > 0 && (
          <section className="mt-10">
            <h2 className="text-lg font-medium">Assets</h2>
            <p className="mt-1 text-xs text-neutral-500">Extracted from every build of this game.</p>
            <AssetGallery buildHref={href} assets={previewAssets} totals={assetTotals(assets)} excerpts={excerpts} />
          </section>
        )}
      </AssetViewerHost>
    </main>
  );
}
