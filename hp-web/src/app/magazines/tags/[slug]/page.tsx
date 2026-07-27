import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { extractAnchor, issueHref, magThumbUrl } from "@/lib/mag/hrefs";
import { getTagBySlug, getTagCoverage, type CoverageItem } from "@/lib/mag/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const tag = await getTagBySlug(getPool(), decodeURIComponent(slug));
  if (!tag) return {};
  return { title: tag.name, description: `Magazine content tagged ${tag.name}` };
}

function CoverageList({ items }: { items: CoverageItem[] }) {
  return (
    <ul className="mt-2 space-y-2">
      {items.map((h) => (
        <li key={h.id}>
          <Link
            href={`${issueHref(h.magazine_slug, h.issue_slug)}#${extractAnchor(h.id)}`}
            className="flex gap-3 rounded-md border border-neutral-200 p-2 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
          >
            {h.crop_sha256 && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={magThumbUrl(h.crop_sha256, 500)}
                alt=""
                className="h-16 w-16 shrink-0 rounded-sm bg-neutral-100 object-cover dark:bg-neutral-800"
                loading="lazy"
              />
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{h.title || h.section || h.kind.replace("_", " ")}</div>
              <div className="text-xs text-neutral-500">
                {h.magazine_title} · {h.issue_label}
                {h.cover_date ? ` · ${h.cover_date.slice(0, 7)}` : ""} ·{" "}
                <span className="rounded bg-neutral-100 px-1 py-0.5 dark:bg-neutral-800">{h.kind.replace("_", " ")}</span>
              </div>
              {h.summary_en && (
                <div className="mt-0.5 line-clamp-2 text-xs text-neutral-600 dark:text-neutral-400">{h.summary_en}</div>
              )}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

// /magazines/tags/<slug> — every extract carrying one tag, in cover-date
// order across all magazines.
export default async function TagPage({ params }: Params) {
  const { slug } = await params;
  const pool = getPool();
  const tag = await getTagBySlug(pool, decodeURIComponent(slug));
  if (!tag) notFound();
  const coverage = await getTagCoverage(pool, tag.slug);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/magazines/tags" className="text-sm text-neutral-500 hover:underline">&larr; Tags</Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">{tag.name}</h1>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          {tag.kind}
        </span>
        <span className="text-neutral-500">
          {tag.extract_count} {tag.extract_count === 1 ? "extract" : "extracts"}
        </span>
      </div>

      {coverage.length === 0 ? (
        <p className="mt-10 text-sm text-neutral-500">Nothing indexed yet.</p>
      ) : (
        <section className="mt-8">
          <CoverageList items={coverage} />
        </section>
      )}
    </main>
  );
}
