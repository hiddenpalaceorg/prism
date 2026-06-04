import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { deriveQueryFeatures } from "@/lib/fingerprint";
import { getBuild, findSimilar, findByEmbeddingOf, fuseSimilar, getCapabilities } from "@/lib/queries";
import type { Node } from "@/lib/types";
import SimilarBuilds from "./SimilarBuilds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FlatFile {
  path: string;
  size?: number;
  sha1?: string;
  dir: boolean;
}

function flatten(nodes: Node[], prefix = ""): FlatFile[] {
  const out: FlatFile[] = [];
  for (const n of nodes) {
    const path = `${prefix}/${n.name}`.replace(/\/+/g, "/");
    if (n.type === "dir") {
      out.push({ path, dir: true });
      out.push(...flatten(n.children, path));
    } else {
      out.push({ path, dir: false, size: n.size, sha1: n.sha1 });
    }
  }
  return out;
}

function humanSize(bytes?: number): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${bytes} B` : `${v.toFixed(1)} ${units[i]}`;
}

export default async function BuildPage({ params }: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await params;
  const pool = getPool();
  const build = await getBuild(pool, sha256);
  if (!build) notFound();

  const q = deriveQueryFeatures(build.record);
  // Pull a wide candidate set per tier so the fused top-50 is well-populated.
  const similar = await findSimilar(pool, q, 100);
  // Text neighbors use this build's already-stored embedding — no re-embedding per load.
  const textNeighbors = await findByEmbeddingOf(pool, sha256, 100);
  const fused = fuseSimilar(similar, textNeighbors);

  // A tier only counts when both builds have its data — attach each build's capabilities
  // (and the query build's) so the fusion can drop inapplicable tiers from the denominator.
  const caps = await getCapabilities(pool, [sha256, ...fused.map((f) => f.sha256)]);
  const queryCaps = caps.get(sha256) ?? [];
  for (const f of fused) f.caps = caps.get(f.sha256) ?? [];

  const files = flatten(build.record.contents);
  const dirCount = files.filter((f) => f.dir).length;

  return (
    <main className="mx-auto max-w-none px-8 py-10">
      <Link href="/builds" className="text-sm text-neutral-500 hover:underline">&larr; All builds</Link>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        {build.record.info?.title as string | undefined ?? build.name}
      </h1>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <Chip>{build.system}</Chip>
        <Chip>{build.file_count} files</Chip>
        <Chip>{humanSize(build.total_size)}</Chip>
        <Chip>profile {build.fingerprint_profile}</Chip>
      </div>

      <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <Hash label="SHA-256" value={build.sha256} />
        <Hash label="SHA-1" value={build.sha1} />
        <Hash label="MD5" value={build.md5} />
        <dt className="text-neutral-500">Content hash</dt>
        <dd className="font-mono text-xs">{build.content_hash ? `${build.content_hash.slice(0, 32)}…` : "—"}</dd>
      </dl>

      <SimilarBuilds builds={fused} queryCaps={queryCaps} />

      <section className="mt-8">
        <h2 className="text-lg font-medium">
          Files <span className="text-sm font-normal text-neutral-400">({files.length - dirCount} files, {dirCount} dirs)</span>
        </h2>
        <ul className="mt-3 max-h-[28rem] overflow-auto rounded-md border border-neutral-200 text-sm dark:border-neutral-800">
          {files.slice(0, 2000).map((f, i) => (
            <li key={i} className="flex items-center justify-between border-b border-neutral-100 px-3 py-1 last:border-0 dark:border-neutral-900">
              <span className={`font-mono ${f.dir ? "text-neutral-400" : ""}`}>
                {f.dir ? "📁" : "📄"} {f.path}
              </span>
              {!f.dir && <span className="text-xs text-neutral-400">{humanSize(f.size)}</span>}
            </li>
          ))}
        </ul>
        {files.length > 2000 && (
          <p className="mt-1 text-xs text-neutral-400">Showing first 2000 of {files.length} entries.</p>
        )}
      </section>
    </main>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">{children}</span>;
}

function Hash({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="font-mono text-xs break-all">{value}</dd>
    </>
  );
}
