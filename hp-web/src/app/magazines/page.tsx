import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { getPool } from "@/lib/db";
import { magazineHref, magThumbUrl } from "@/lib/mag/hrefs";
import { listMagazines } from "@/lib/mag/queries";
import MagSearch from "./MagSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Magazines",
  description: "Searchable index of gaming magazine content: reviews, previews, interviews, ads, charts.",
};

// /magazines — every indexed magazine with its first cover and issue count,
// plus full-text search across all extracts.
export default async function MagazinesPage() {
  const magazines = await listMagazines(getPool());

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <Link href="/" className="text-sm text-neutral-500 hover:underline">&larr; Search</Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Magazines</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Page-by-page index of gaming print media: every review, preview, interview, ad, chart, and tip,
        searchable in the original language and in English.
      </p>

      <Suspense>
        <MagSearch magazines={magazines.map((m) => ({ slug: m.slug, title: m.title }))} />
      </Suspense>

      {magazines.length === 0 ? (
        <p className="mt-10 text-sm text-neutral-500">Nothing indexed yet.</p>
      ) : (
        <ul className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {magazines.map((m) => (
            <li key={m.slug}>
              <Link
                href={magazineHref(m.slug)}
                className="block rounded-md border border-neutral-300 p-3 transition-colors hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500"
              >
                {m.cover_sha ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={magThumbUrl(m.cover_sha, 500)}
                    alt={`${m.title} cover`}
                    className="aspect-[3/4] w-full rounded-sm bg-neutral-100 object-cover dark:bg-neutral-800"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex aspect-[3/4] w-full items-center justify-center rounded-sm bg-neutral-100 text-xs text-neutral-400 dark:bg-neutral-800" >
                    no cover yet
                  </div>
                )}
                <div className="mt-2 truncate text-sm font-medium">{m.title}</div>
                <div className="text-xs text-neutral-500">
                  {m.issue_count} {m.issue_count === 1 ? "issue" : "issues"}
                  {m.country ? ` · ${m.country}` : ""}
                  {m.language ? ` · ${m.language}` : ""}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
