import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { deriveQueryFeatures } from "@/lib/fingerprint";
import { buildTree, initialExpanded, pruneToExpanded, treeCounts } from "@/lib/filetree";
import { getBuild, findSimilar, findByEmbeddingOf, fuseSimilar, getCapabilities } from "@/lib/queries";
import type { BuildRecord } from "@/lib/types";
import SimilarBuilds from "./SimilarBuilds";
import FileTree from "./FileTree";

export const runtime = "nodejs";
// The corpus only changes at ingest; render once and serve cached for an hour
// (the moderation accept endpoint revalidates the affected paths immediately).
// The empty generateStaticParams is load-bearing: without it a dynamic route
// is rendered per-request and `revalidate` never engages — with it, pages are
// ISR-cached on first visit and refreshed in the background.
export const revalidate = 3600;
export function generateStaticParams(): Array<{ sha256: string }> {
  return [];
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

function titleize(k: string): string {
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Light touch-up: turn YYYYMMDD date fields into YYYY-MM-DD; leave everything else as-is.
function formatMetaValue(key: string, value: string): string {
  if (/date/i.test(key)) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return value;
}

interface MetaSection {
  title: string;
  entries: [string, string][];
}

// Flatten the canonical record's metadata into display sections, generically — so any
// info/structural field (present-day or future) is shown without per-system special-casing.
function metaSections(record: BuildRecord): MetaSection[] {
  const sections: MetaSection[] = [];
  const info = (record.info ?? {}) as Record<string, unknown>;

  // Scalar info fields (disc_type, system_identifier, …); `system` is already a header chip.
  const disc: [string, string][] = [];
  for (const [k, v] of Object.entries(info)) {
    if (v == null || k === "system" || typeof v === "object") continue;
    disc.push([k, String(v)]);
  }
  if (disc.length) sections.push({ title: "Disc", entries: disc });

  // Nested info objects: header, volume, exe, …
  for (const [k, v] of Object.entries(info)) {
    if (!v || typeof v !== "object") continue;
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, vv]) => vv != null && vv !== "")
      .map(([kk, vv]) => [kk, String(vv)] as [string, string]);
    if (entries.length) sections.push({ title: titleize(k), entries });
  }

  // Composites: surface the incomplete-file count when present.
  const c = record.composites;
  if (c && typeof c.incomplete_files === "number") {
    sections.push({ title: "Composites", entries: [["incomplete_files", String(c.incomplete_files)]] });
  }

  return sections;
}

export default async function BuildPage({ params }: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await params;
  const pool = getPool();
  const build = await getBuild(pool, sha256);
  if (!build) notFound();

  const q = deriveQueryFeatures(build.record);
  // Pull a wide candidate set per tier so the fused top-50 is well-populated.
  // Text neighbors use this build's already-stored embedding — no re-embedding per load.
  const [similar, textNeighbors] = await Promise.all([
    findSimilar(pool, q, 100),
    findByEmbeddingOf(pool, sha256, 100),
  ]);
  const fused = fuseSimilar(similar, textNeighbors);

  // A tier only counts when both builds have its data — attach each build's capabilities
  // (and the query build's) so the fusion can drop inapplicable tiers from the denominator.
  const caps = await getCapabilities(pool, [sha256, ...fused.map((f) => f.sha256)]);
  const queryCaps = caps.get(sha256) ?? [];
  for (const f of fused) f.caps = caps.get(f.sha256) ?? [];

  // Ship only the initially-visible subtree; FileTree lazily fetches the rest.
  const tree = buildTree(build.record.contents);
  const expanded = initialExpanded(tree);
  const counts = treeCounts(tree);
  const meta = metaSections(build.record);
  const filteredContentHash = build.record.composites?.filtered_content_hash;

  return (
    <main className="mx-auto max-w-none px-4 py-10 sm:px-8">
      <Link href="/builds" className="text-sm text-neutral-500 hover:underline">&larr; All builds</Link>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        {build.record.info?.title as string | undefined ?? build.name}
      </h1>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <Chip>{build.system || "unknown"}</Chip>
        <Chip>{build.file_count} files</Chip>
        <Chip>{humanSize(build.total_size)}</Chip>
        <Chip>profile {build.fingerprint_profile}</Chip>
      </div>

      <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <Hash label="SHA-256" value={build.sha256} />
        <Hash label="SHA-1" value={build.sha1} />
        <Hash label="MD5" value={build.md5} />
        <Hash label="Content hash" value={build.content_hash ?? "—"} />
        {filteredContentHash && filteredContentHash !== build.content_hash && (
          <Hash label="Filtered content hash" value={filteredContentHash} />
        )}
      </dl>

      {meta.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Metadata</h2>
          <div className="mt-3 grid gap-x-12 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {meta.map((sec) => (
              <div key={sec.title}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{sec.title}</h3>
                <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                  {sec.entries.map(([k, v]) => (
                    <Fragment key={k}>
                      <dt className="text-neutral-500">{titleize(k)}</dt>
                      <dd className="break-all">{formatMetaValue(k, v)}</dd>
                    </Fragment>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </section>
      )}

      <SimilarBuilds builds={fused} queryCaps={queryCaps} />

      <section className="mt-8">
        <h2 className="text-lg font-medium">
          Files <span className="text-sm font-normal text-neutral-400">({counts.files} files, {counts.dirs} dirs)</span>
        </h2>
        <FileTree sha256={sha256} roots={pruneToExpanded(tree, expanded)} initiallyExpanded={[...expanded]} />
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
