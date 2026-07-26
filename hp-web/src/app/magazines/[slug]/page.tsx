import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { issueHref, magThumbUrl } from "@/lib/mag/hrefs";
import { getMagazineBySlug, listIssues } from "@/lib/mag/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const magazine = await getMagazineBySlug(getPool(), decodeURIComponent(slug));
  if (!magazine) return {};
  return { title: magazine.title, description: `${magazine.title}: indexed issues` };
}

// /magazines/<slug> — one magazine: identity block and the issue grid.
export default async function MagazinePage({ params }: Params) {
  const { slug } = await params;
  const pool = getPool();
  const magazine = await getMagazineBySlug(pool, decodeURIComponent(slug));
  if (!magazine) notFound();
  const issues = await listIssues(pool, magazine.id);

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <Link href="/magazines" className="text-sm text-neutral-500 hover:underline">&larr; Magazines</Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">{magazine.title}</h1>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {magazine.publisher && (
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
            {magazine.publisher}
          </span>
        )}
        {magazine.country && (
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">{magazine.country}</span>
        )}
        {magazine.language && (
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">{magazine.language}</span>
        )}
        {magazine.aliases.length > 0 && (
          <span className="text-neutral-500">also known as {magazine.aliases.join(", ")}</span>
        )}
      </div>
      {magazine.notes && <p className="mt-3 max-w-prose text-sm text-neutral-600 dark:text-neutral-400">{magazine.notes}</p>}

      {issues.length === 0 ? (
        <p className="mt-10 text-sm text-neutral-500">No issues indexed yet.</p>
      ) : (
        <ul className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {issues.map((i) => (
            <li key={i.slug}>
              <Link
                href={issueHref(magazine.slug, i.slug)}
                className="block rounded-md border border-neutral-300 p-3 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500"
              >
                {i.cover_sha ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={magThumbUrl(i.cover_sha, 500)}
                    alt={`${i.label} cover`}
                    className="aspect-[3/4] w-full rounded-sm bg-neutral-100 object-cover dark:bg-neutral-800"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex aspect-[3/4] w-full items-center justify-center rounded-sm bg-neutral-100 text-xs text-neutral-400 dark:bg-neutral-800">
                    rendering…
                  </div>
                )}
                <div className="mt-2 truncate text-sm font-medium">{i.label}</div>
                <div className="text-xs text-neutral-500">
                  {i.cover_date ? i.cover_date.slice(0, i.cover_date_precision === "year" ? 4 : 7) : "undated"}
                  {" · "}
                  {i.extract_count} {i.extract_count === 1 ? "extract" : "extracts"}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
