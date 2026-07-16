import type { Metadata } from "next";
import Link from "next/link";
import { getPool } from "@/lib/db";
import { listBuildsPage, type BuildSortKey } from "@/lib/queries";
import BuildsBrowser from "./BuildsBrowser";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Builds",
  description: "Browse and search every build in the Hidden Palace library.",
};

const PER_PAGE = 100;

const SORT_KEYS: BuildSortKey[] = ["name", "system", "build_date", "file_count", "total_size"];

// Search/filter/sort/pagination all resolve in SQL — the old version shipped
// every build (a 6MB payload at 16k builds) and filtered client-side.
export default async function BuildsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
  const q = str(sp.q);
  const system = str(sp.system);
  const lot = str(sp.lot);
  const sort = (SORT_KEYS as string[]).includes(str(sp.sort)) ? (str(sp.sort) as BuildSortKey) : "name";
  const dir = str(sp.dir) === "desc" ? "desc" : "asc";
  const page = Math.max(parseInt(str(sp.page), 10) || 1, 1);

  const { rows, total, systems } = await listBuildsPage(getPool(), {
    q,
    system,
    lot,
    sort,
    dir,
    offset: (page - 1) * PER_PAGE,
    limit: PER_PAGE,
  });

  return (
    <main className="mx-auto max-w-none px-8 py-10">
      <Link href="/" className="text-sm text-neutral-500 hover:underline">&larr; Search</Link>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        Builds <span className="text-sm font-normal text-neutral-400">({total})</span>
      </h1>

      <BuildsBrowser
        rows={rows}
        total={total}
        systems={systems}
        page={page}
        perPage={PER_PAGE}
        q={q}
        system={system}
        lot={lot}
        sort={sort}
        dir={dir}
      />
    </main>
  );
}
