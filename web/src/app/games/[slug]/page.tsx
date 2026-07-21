import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getModeratorFromHeaders } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { getGameAssets, getGameBySlug, getGameBuilds } from "@/lib/queries";
import { assetExcerpts, assetMonths, assetTotals, orderAssets } from "@/lib/assets";
import AssetGallery from "../../builds/[buildId]/AssetGallery";
import AssetViewerHost from "../../builds/[buildId]/AssetViewerHost";
import GameBuilds from "./GameBuilds";

// The timeline previews at most this many items per kind per month; the
// rest live on /games/<slug>/assets. Excerpt reads stay bounded regardless.
const MONTH_PREVIEW_PER_KIND = { image: 18, audio: 8, video: 6, document: 8, source: 6, text: 6, binary: 6 };
const MAX_EXCERPT_READS = 200;

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
  // Timeline: one bucket per month of the assets' own file dates. The viewer
  // steps through the whole timeline in order; each month's gallery shows a
  // capped preview, with the full set on /games/<slug>/assets.
  const months = assetMonths(assets).map((m) => ({
    ...m,
    preview: orderAssets(m.assets, MONTH_PREVIEW_PER_KIND),
    totals: assetTotals(m.assets),
  }));
  const ordered = months.flatMap((m) => orderAssets(m.assets));
  const excerpts = await assetExcerpts(
    months.flatMap((m) => m.preview),
    MAX_EXCERPT_READS
  );

  return (
    <main className="mx-auto max-w-none px-4 py-10 sm:px-8">
      <AssetViewerHost assets={ordered} buildHref={href} returnHref={href}>
        <div className="mx-auto max-w-4xl">
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
        </div>

        {assets.length > 0 && (
          <section className="mt-10">
            <h2 className="text-lg font-medium">Assets</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Extracted from every build of this game, by the files&apos; own dates.
            </p>
            {months.map((m) => (
              <div key={m.key} className="mt-8 first:mt-4">
                <h3 className="border-b border-neutral-200 pb-1 text-sm font-semibold dark:border-neutral-800">
                  {m.label}
                  <span className="ml-2 font-normal text-neutral-400">
                    {m.assets.length} {m.assets.length === 1 ? "file" : "files"}
                  </span>
                </h3>
                <AssetGallery buildHref={href} assets={m.preview} totals={m.totals} excerpts={excerpts} />
              </div>
            ))}
          </section>
        )}
      </AssetViewerHost>
    </main>
  );
}
