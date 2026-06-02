import Link from "next/link";
import { getPool } from "@/lib/db";
import { listBuilds } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function humanSize(bytes?: number): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
}

export default async function BuildsPage() {
  const pool = getPool();
  const builds = await listBuilds(pool);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/" className="text-sm text-neutral-500 hover:underline">&larr; Search</Link>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        Builds <span className="text-sm font-normal text-neutral-400">({builds.length})</span>
      </h1>

      {builds.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">No builds in the catalog yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800">
          {builds.map((b) => (
            <li key={b.sha256} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <Link href={`/builds/${b.sha256}`} className="font-medium hover:underline">
                  {b.name}
                </Link>
                <div className="mt-0.5 font-mono text-xs text-neutral-400">{b.sha256.slice(0, 16)}…</div>
              </div>
              <span className="flex shrink-0 items-center gap-3 text-xs text-neutral-500">
                <Chip>{b.system}</Chip>
                <span>{b.file_count} files</span>
                <span>{humanSize(b.total_size)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">{children}</span>;
}
