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
    <main className="mx-auto max-w-none px-8 py-10">
      <Link href="/" className="text-sm text-neutral-500 hover:underline">&larr; Search</Link>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        Builds <span className="text-sm font-normal text-neutral-400">({builds.length})</span>
      </h1>

      {builds.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">No builds in the library yet.</p>
      ) : (
        <table className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-200/80 text-left text-xs font-medium text-neutral-400 dark:border-neutral-800/80">
              <th className="px-3 py-1.5 first:pl-0">Name</th>
              <th className="px-3 py-1.5">SHA-256</th>
              <th className="px-3 py-1.5">System</th>
              <th className="px-3 py-1.5 text-right">Files</th>
              <th className="px-3 py-1.5 text-right last:pr-0">Size</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-900/60">
            {builds.map((b) => (
              <tr key={b.sha256} className="hover:bg-neutral-50 dark:hover:bg-neutral-900/40">
                <td className="px-3 py-1.5 font-medium first:pl-0">
                  <Link href={`/builds/${b.sha256}`} className="hover:underline">{b.name}</Link>
                </td>
                <td className="px-3 py-1.5 font-mono text-xs text-neutral-400">{b.sha256.slice(0, 16)}…</td>
                <td className="px-3 py-1.5"><Chip>{b.system}</Chip></td>
                <td className="px-3 py-1.5 text-right tabular-nums text-neutral-500">{b.file_count}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-neutral-500 last:pr-0">{humanSize(b.total_size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">{children}</span>;
}
