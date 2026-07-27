import type { Metadata } from "next";
import Link from "next/link";
import { getPool } from "@/lib/db";
import { tagHref } from "@/lib/mag/hrefs";
import { listTags } from "@/lib/mag/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Magazine tags",
  description: "Companies, events, hardware, series, and topics across the magazine index.",
};

const KIND_GROUPS: { kind: string; title: string }[] = [
  { kind: "company", title: "Companies" },
  { kind: "event", title: "Events" },
  { kind: "hardware", title: "Hardware" },
  { kind: "series", title: "Series" },
  { kind: "topic", title: "Topics" },
];

// /magazines/tags — every tag in the index, grouped by kind, with extract
// counts. Tags with nothing attached yet are left out.
export default async function TagsPage() {
  const tags = (await listTags(getPool())).filter((t) => t.extract_count > 0);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/magazines" className="text-sm text-neutral-500 hover:underline">&larr; Magazines</Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Tags</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Everything indexed that is not a game, person, or system: companies, events, hardware, series, topics.
      </p>

      {tags.length === 0 ? (
        <p className="mt-10 text-sm text-neutral-500">Nothing tagged yet.</p>
      ) : (
        KIND_GROUPS.map((g) => {
          const items = tags.filter((t) => t.kind === g.kind);
          if (items.length === 0) return null;
          return (
            <section key={g.kind} className="mt-8">
              <h2 className="text-lg font-medium">
                {g.title} <span className="text-sm font-normal text-neutral-400">{items.length}</span>
              </h2>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {items.map((t) => (
                  <Link
                    key={t.slug}
                    href={tagHref(t.slug)}
                    className="rounded bg-neutral-100 px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                  >
                    {t.name} <span className="text-xs text-neutral-400">{t.extract_count}</span>
                  </Link>
                ))}
              </div>
            </section>
          );
        })
      )}
    </main>
  );
}
