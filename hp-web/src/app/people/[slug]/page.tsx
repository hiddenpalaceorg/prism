import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { extractAnchor, issueHref, magThumbUrl } from "@/lib/mag/hrefs";
import { getPersonBySlug, getPersonCoverage, type CoverageItem } from "@/lib/mag/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const person = await getPersonBySlug(getPool(), decodeURIComponent(slug));
  if (!person) return {};
  return { title: person.name, description: `Magazine appearances of ${person.name}` };
}

const ROLE_GROUPS: { title: string; roles: string[] }[] = [
  { title: "Interviews", roles: ["interviewee"] },
  { title: "Written and drawn", roles: ["author", "artist", "reviewer", "interviewer"] },
  { title: "Coverage", roles: ["subject"] },
  { title: "Mentions", roles: ["mentioned"] },
];

function CoverageList({ items }: { items: CoverageItem[] }) {
  return (
    <ul className="mt-2 space-y-2">
      {items.map((h) => (
        <li key={`${h.id}-${h.role}`}>
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

// /people/<slug> — a person, persona, or organization across the magazine
// index: interviews first, then bylines, then coverage and mentions.
export default async function PersonPage({ params }: Params) {
  const { slug } = await params;
  const pool = getPool();
  const person = await getPersonBySlug(pool, decodeURIComponent(slug));
  if (!person) notFound();
  const coverage = await getPersonCoverage(pool, person.id);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/magazines" className="text-sm text-neutral-500 hover:underline">&larr; Magazines</Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        {person.name}
        {person.name_original && person.name_original !== person.name && (
          <span className="ml-2 text-lg font-normal text-neutral-500">{person.name_original}</span>
        )}
      </h1>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {person.kind !== "person" && (
          <span className="rounded bg-violet-100 px-1.5 py-0.5 font-medium text-violet-900 dark:bg-violet-900/40 dark:text-violet-200">
            {person.kind}
          </span>
        )}
        {person.aliases.length > 0 && <span className="text-neutral-500">also credited as {person.aliases.join(", ")}</span>}
      </div>
      {person.notes && <p className="mt-3 max-w-prose text-sm text-neutral-600 dark:text-neutral-400">{person.notes}</p>}

      {coverage.length === 0 ? (
        <p className="mt-10 text-sm text-neutral-500">No indexed appearances yet.</p>
      ) : (
        ROLE_GROUPS.map((g) => {
          const items = coverage.filter((c) => g.roles.includes(c.role));
          if (items.length === 0) return null;
          return (
            <section key={g.title} className="mt-8">
              <h2 className="text-lg font-medium">
                {g.title} <span className="text-sm font-normal text-neutral-400">{items.length}</span>
              </h2>
              <CoverageList items={items} />
            </section>
          );
        })
      )}
    </main>
  );
}
