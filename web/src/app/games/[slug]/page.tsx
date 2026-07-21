import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { getGameBySlug, getGameBuilds } from "@/lib/queries";
import { humanSize } from "@/lib/meta";
import { buildHref } from "@/lib/slug";

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
  const title = game.system ? `${game.name} (${game.system})` : game.name;
  return { title: `${title} · Hidden Palace` };
}

// /games/<slug> — every visible build of one game, oldest first. The slug is
// <name>--<system> (name alone when the system is unknown); private builds
// stay hidden, exactly like the /builds browser.
export default async function GamePage({ params }: Params) {
  const { slug } = await params;
  const pool = getPool();
  const game = await getGameBySlug(pool, decodeURIComponent(slug));
  if (!game) notFound();

  const builds = await getGameBuilds(pool, game.id);

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-8">
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

      {builds.length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">No public builds for this game.</p>
      ) : (
        <ul className="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800">
          {builds.map((b) => (
            <li key={b.sha256}>
              <Link
                href={buildHref(b.sha256, b.name)}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5 hover:bg-neutral-50 dark:hover:bg-neutral-900"
              >
                <span className="min-w-0 flex-1 break-words font-medium">{b.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-neutral-500">
                  {b.build_date ? b.build_date.slice(0, 10) : "—"}
                </span>
                <span className="w-20 shrink-0 text-right text-xs tabular-nums text-neutral-500">
                  {humanSize(b.total_size)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
