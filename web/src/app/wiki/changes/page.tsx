// RecentChanges: the sitewide edit feed, public read.
// ?user= filters to one author (contributions view); ?limit= caps the feed.

import type { Metadata } from "next";
import Link from "next/link";
import { listRecentChanges } from "cube";
import { getCube, pageHref } from "@/cube/cube";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Recent changes - Hidden Palace" };

const LINK = "text-blue-600 hover:underline dark:text-blue-400";
const TH = "border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-left dark:border-neutral-800 dark:bg-neutral-900";
const TD = "border border-neutral-200 px-3 py-1.5 dark:border-neutral-800";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function num(v: string | string[] | undefined): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export default async function RecentChangesPage({ searchParams }: Props) {
  const sp = await searchParams;
  const user = typeof sp.user === "string" && sp.user !== "" ? sp.user : undefined;
  const changes = await listRecentChanges(getCube().pool(), {
    limit: num(sp.limit) ?? 100,
    before: num(sp.before),
    user,
  });

  return (
    <main>
      <h1 className="mb-4 text-2xl font-semibold">
        Recent changes{user ? `: ${user}` : ""}
      </h1>
      {user && (
        <p className="mb-4 text-sm">
          <Link className={LINK} href="/wiki/changes">
            Show all changes
          </Link>
        </p>
      )}
      {changes.length === 0 ? (
        <p className="text-sm text-neutral-500">No changes yet.</p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className={TH}>Page</th>
              <th className={TH}>Revision</th>
              <th className={TH}>Date</th>
              <th className={TH}>Author</th>
              <th className={TH}>Comment</th>
              <th className={TH}>Delta</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => {
              const href = pageHref({ ns: c.ns, slug: c.slug });
              return (
                <tr key={c.revId}>
                  <td className={TD}>
                    <Link className={LINK} href={href}>
                      {c.title}
                    </Link>
                  </td>
                  <td className={TD}>
                    <Link className={LINK} href={`${href}?rev=${c.revId}`}>
                      r{c.revId}
                    </Link>
                  </td>
                  <td className={TD}>{new Date(c.createdAt).toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td className={TD}>
                    <Link className={LINK} href={`/wiki/changes?user=${encodeURIComponent(c.author)}`}>
                      {c.author}
                    </Link>
                  </td>
                  <td className={TD}>
                    {c.comment}
                    {c.minor ? " (minor)" : ""}
                  </td>
                  <td className={`${TD} ${c.delta > 0 ? "text-green-700 dark:text-green-400" : c.delta < 0 ? "text-red-700 dark:text-red-400" : "text-neutral-500"}`}>
                    {c.delta > 0 ? `+${c.delta}` : c.delta}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </main>
  );
}
