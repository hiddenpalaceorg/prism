import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { deriveQueryFeatures } from "@/lib/fingerprint";
import { getBuild, findSimilar, findByEmbedding } from "@/lib/queries";
import { embed, toPgVector } from "@/lib/embed";
import type { Node } from "@/lib/types";

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

interface Neighbor {
  sha256: string;
  name: string;
  system: string;
  score?: string;
}

export default async function BuildPage({ params }: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await params;
  const pool = getPool();
  const build = await getBuild(pool, sha256);
  if (!build) notFound();

  const q = deriveQueryFeatures(build.record);
  const similar = await findSimilar(pool, q);
  const textNeighbors = build.record.text_doc
    ? await findByEmbedding(pool, toPgVector(await embed(build.record.text_doc)), sha256)
    : [];

  const sections: { title: string; items: Neighbor[] }[] = [
    { title: "Identical content (Tier 1)", items: similar.tier1_twins.map((x) => ({ ...x })) },
    { title: "Shared files (Tier 2)", items: similar.tier2.map((x) => ({ ...x, score: `${Math.round((x.jaccard ?? 0) * 100)}%` })) },
    { title: "Similar chunks (Tier 3)", items: similar.tier3.map((x) => ({ ...x, score: `${Math.round((x.jaccard ?? 0) * 100)}%` })) },
    { title: "Same boot imports (Tier 5)", items: similar.tier5_exe.map((x) => ({ ...x })) },
    { title: "Similar executable (TLSH)", items: similar.tier5_tlsh.map((x) => ({ ...x, score: `d=${x.distance}` })) },
    { title: "Shared audio tracks", items: similar.audio_neighbors.map((x) => ({ ...x, score: `${x.matched_tracks} tracks` })) },
    { title: "Semantically related (text)", items: textNeighbors.map((x) => ({ sha256: x.sha256, name: x.name, system: x.system, score: x.cosine == null ? undefined : x.cosine.toFixed(2) })) },
  ].filter((s) => s.items.length > 0);

  const files = flatten(build.record.contents);
  const dirCount = files.filter((f) => f.dir).length;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/" className="text-sm text-neutral-500 hover:underline">&larr; Search</Link>

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
        <dd className="font-mono text-xs">{build.content_hash.slice(0, 32)}…</dd>
      </dl>

      {sections.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Similar builds</h2>
          <div className="mt-3 space-y-5">
            {sections.map((s) => (
              <div key={s.title}>
                <p className="mb-1 text-xs uppercase tracking-wide text-neutral-400">{s.title}</p>
                <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {s.items.map((n) => (
                    <li key={n.sha256} className="flex items-center justify-between py-2">
                      <Link href={`/build/${n.sha256}`} className="hover:underline">
                        {n.name}
                      </Link>
                      <span className="flex gap-3 text-xs text-neutral-500">
                        <Chip>{n.system}</Chip>
                        {n.score && <span className="font-mono">{n.score}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

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
