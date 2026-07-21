import { Fragment } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { deriveQueryFeatures } from "@/lib/fingerprint";
import { buildTree, initialExpanded, pruneToExpanded, treeCounts } from "@/lib/filetree";
import { getBuild, getBuildAssets, getBuildDuplicates, getBuildMeta, getBuildRepos, findSimilar, findByEmbeddingOf, fuseSimilar, getCapabilities, listLots, isLotPrivate, resolveBuild } from "@/lib/queries";
import { shortOid } from "@/lib/repo-manifest";
import { assetExcerpts, assetTotals, orderAssets } from "@/lib/assets";
import { getBuildMedia, getBuildNotes, getBuildSkip, mediaView } from "@/lib/media";
import { buildDescription, displayTitle } from "@/lib/meta";
import { canonicalBuildId, parseBuildParam } from "@/lib/slug";
import type { BuildRecord } from "@/lib/types";
import SimilarBuilds from "./SimilarBuilds";
import FileTree from "./FileTree";
import AssetGallery from "./AssetGallery";
import AssetViewerHost from "./AssetViewerHost";
import MediaSection from "./MediaSection";
import ModeratorTools from "./ModeratorTools";
import NotesSection from "./NotesSection";

// The assets section previews at most this many items per kind; the rest live
// on /builds/<id>/assets.
const ASSET_PREVIEW_PER_KIND = { image: 30, audio: 20, video: 10, document: 12, source: 10, text: 10, binary: 9 };

export const runtime = "nodejs";
// The corpus only changes at ingest; render once and serve cached for an hour
// (the moderation accept endpoint revalidates the affected paths immediately).
// The empty generateStaticParams is load-bearing: without it a dynamic route
// is rendered per-request and `revalidate` never engages — with it, pages are
// ISR-cached on first visit and refreshed in the background.
export const revalidate = 3600;
export function generateStaticParams(): Array<{ buildId: string }> {
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

// Social-preview metadata (og:*/twitter:*) so shared build links unfurl with
// the build's title, facts, and the generated card (opengraph-image.tsx).
export async function generateMetadata({ params }: { params: Promise<{ buildId: string }> }): Promise<Metadata> {
  const { buildId } = await params;
  const parsed = parseBuildParam(buildId);
  if (!parsed) return {};
  const pool = getPool();
  const resolved = await resolveBuild(pool, parsed.hex, parsed.slug);
  if (!resolved) return {};
  const meta = await getBuildMeta(pool, resolved.sha256);
  if (!meta) return {};
  const href = `/builds/${canonicalBuildId(meta.sha256, meta.name)}`;
  const title = displayTitle(meta);
  const description = buildDescription(meta);
  return {
    title,
    description,
    alternates: { canonical: href },
    // siteName repeated here: a deeper segment's openGraph replaces the
    // layout's whole object (Next merges per-field, not deep).
    openGraph: { title, description, url: href, siteName: "Hidden Palace" },
    twitter: { card: "summary_large_image" },
  };
}

export default async function BuildPage({ params }: { params: Promise<{ buildId: string }> }) {
  const { buildId } = await params;
  const parsed = parseBuildParam(buildId);
  if (!parsed) notFound();
  const pool = getPool();
  // Any unique sha256 prefix (with or without slug) resolves; everything
  // non-canonical redirects to the canonical <short sha>-<slug> URL.
  const resolved = await resolveBuild(pool, parsed.hex, parsed.slug);
  if (!resolved) notFound();
  const canonical = canonicalBuildId(resolved.sha256, resolved.name);
  if (buildId !== canonical) permanentRedirect(`/builds/${canonical}`);
  const sha256 = resolved.sha256;
  const href = `/builds/${canonical}`;

  const build = await getBuild(pool, sha256);
  if (!build) notFound();

  const q = deriveQueryFeatures(build.record);
  // Pull a wide candidate set per tier so the fused top-50 is well-populated.
  // Text neighbors use this build's already-stored embedding — no re-embedding per load.
  const [similar, textNeighbors, assets, lots, repos, lotPrivate, media, notes, skips, duplicates] = await Promise.all([
    findSimilar(pool, q, 100),
    findByEmbeddingOf(pool, sha256, 100),
    getBuildAssets(pool, sha256),
    listLots(pool),
    getBuildRepos(pool, sha256),
    build.lot ? isLotPrivate(pool, build.lot) : Promise.resolve(false),
    getBuildMedia(pool, sha256),
    getBuildNotes(pool, sha256),
    getBuildSkip(pool, sha256),
    getBuildDuplicates(pool, sha256),
  ]);
  const fused = fuseSimilar(similar, textNeighbors);

  // A tier only counts when both builds have its data — attach each build's capabilities
  // (and the query build's) so the fusion can drop inapplicable tiers from the denominator.
  const caps = await getCapabilities(pool, [sha256, ...fused.map((f) => f.sha256)]);
  const queryCaps = caps.get(sha256) ?? [];
  for (const f of fused) f.caps = caps.get(f.sha256) ?? [];

  // Preview subset for the assets section, plus server-read excerpts for its
  // source/text/binary cards (tiny head reads from the local blob store).
  const previewAssets = orderAssets(assets, ASSET_PREVIEW_PER_KIND);
  const excerpts = await assetExcerpts(previewAssets);

  // Ship only the initially-visible subtree; FileTree lazily fetches the rest.
  const tree = buildTree(build.record.contents);
  const expanded = initialExpanded(tree);
  const counts = treeCounts(tree);
  const meta = metaSections(build.record);
  // A later rename can make the build's own name match a recorded duplicate;
  // don't list the current name under itself.
  const dupNames = duplicates.filter((d) => d.name !== build.name);
  const filteredContentHash = build.record.composites?.filtered_content_hash;
  const discTitle = build.record.info?.title as string | undefined;

  return (
    <main className="mx-auto max-w-none px-4 py-10 sm:px-8">
      {/* One lightbox for the whole page (gallery + file tree); it rewrites the
          URL to <href>/assets/<path> while an asset is open. */}
      <AssetViewerHost assets={assets} buildHref={href} returnHref={href}>
      <Link href="/builds" className="text-sm text-neutral-500 hover:underline">&larr; All builds</Link>

      {/* The name column is the display identity everywhere (lists, search, rename);
          the disc's own title stays visible as a subtitle when it differs. */}
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">{build.name}</h1>
      {discTitle && discTitle !== build.name && (
        <p className="mt-1 text-sm text-neutral-500">{discTitle}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <Chip>{build.system || "unknown"}</Chip>
        <Chip>{build.file_count} files</Chip>
        <Chip>{humanSize(build.total_size)}</Chip>
        <Chip>profile {build.fingerprint_profile}</Chip>
        {assets.length > 0 && <Chip>{assets.length} assets</Chip>}
        {build.game &&
          (build.game_slug ? (
            <Link
              href={`/games/${build.game_slug}`}
              className="rounded bg-sky-100 px-1.5 py-0.5 font-medium text-sky-900 hover:underline dark:bg-sky-900/40 dark:text-sky-200"
            >
              {build.game}
            </Link>
          ) : (
            <span className="rounded bg-sky-100 px-1.5 py-0.5 font-medium text-sky-900 dark:bg-sky-900/40 dark:text-sky-200">
              {build.game}
            </span>
          ))}
        {build.lot && (
          <Link
            href={`/builds?lot=${encodeURIComponent(build.lot)}`}
            className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900 hover:underline dark:bg-amber-900/40 dark:text-amber-200"
          >
            {build.lot}
          </Link>
        )}
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

      <ModeratorTools
        key={`${build.name}\0${build.lot ?? ""}\0${build.game ?? ""}\0${build.game_system ?? ""}\0${build.private}\0${lotPrivate}\0${JSON.stringify(skips)}`}
        sha256={build.sha256}
        name={build.name}
        lot={build.lot}
        lots={lots}
        game={build.game}
        gameSystem={build.game_system}
        privateFlag={build.private}
        lotPrivate={lotPrivate}
        skips={skips}
      />

      {(meta.length > 0 || dupNames.length > 0) && (
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
            {dupNames.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Duplicates</h3>
                <ul className="mt-2 space-y-1 text-sm">
                  {dupNames.map((d) => (
                    <li key={d.name} className="break-all">
                      {d.name} <span className="text-xs text-neutral-500">by {d.nickname}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {repos.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">
            Source {repos.length === 1 ? "repository" : "repositories"}
          </h2>
          <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-900/60">
            {repos.map((r) => (
              <li key={r.name} className="flex items-center gap-3 py-2 text-sm">
                <Link
                  href={`${href}/repo/${encodeURIComponent(r.name)}`}
                  className="min-w-0 truncate font-mono font-medium hover:underline"
                >
                  {r.name}
                </Link>
                <Chip>{r.commit_count} commits</Chip>
                <Chip>
                  <span className="font-mono">{r.head_ref ?? shortOid(r.head_oid)}</span>
                </Chip>
                <span className="text-xs text-neutral-500">attached {r.created_at.slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <SimilarBuilds builds={fused} queryCaps={queryCaps} />

      {assets.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">
            Assets <span className="text-sm font-normal text-neutral-400">({assets.length})</span>
          </h2>
          <AssetGallery buildHref={href} assets={previewAssets} totals={assetTotals(assets)} excerpts={excerpts} />
        </section>
      )}

      <MediaSection sha256={sha256} items={media.map(mediaView)} skips={skips} />

      <NotesSection sha256={sha256} notes={notes} skipped={skips.skip_notes} />

      <section className="mt-8">
        <h2 className="text-lg font-medium">
          Files <span className="text-sm font-normal text-neutral-400">({counts.files} files, {counts.dirs} dirs)</span>
        </h2>
        <FileTree sha256={sha256} roots={pruneToExpanded(tree, expanded)} initiallyExpanded={[...expanded]} assets={assets} />
      </section>
      </AssetViewerHost>
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
