import Link from "next/link";
import { getPool } from "@/lib/db";
import { listBuilds } from "@/lib/queries";
import BuildsBrowser from "./BuildsBrowser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function BuildsPage() {
  const pool = getPool();
  const builds = await listBuilds(pool);

  return (
    <main className="mx-auto max-w-none px-8 py-10">
      <Link href="/" className="text-sm text-neutral-500 hover:underline">&larr; Search</Link>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        Builds <span className="text-sm font-normal text-neutral-400">({builds.length})</span>
      </h1>

      {builds.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">No builds in the library yet.</p>
      ) : (
        <BuildsBrowser builds={builds} />
      )}
    </main>
  );
}
