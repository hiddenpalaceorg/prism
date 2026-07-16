import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { buildTree, initialExpanded, pruneToExpanded, treeCounts } from "@/lib/filetree";
import { getBuildRepo, resolveBuild } from "@/lib/queries";
import { loadRepo } from "@/lib/repo";
import {
  commitsPage,
  entryAt,
  fileLog,
  resolveRev,
  shortOid,
  treeNodesAt,
  type RepoLogEntryDto,
} from "@/lib/repo-manifest";
import { canonicalBuildId, normalizeAssetPath, parseBuildParam, safeDecodeSegment } from "@/lib/slug";
import RepoViewer from "./RepoViewer";

export const runtime = "nodejs";
// Deliberately not the build page's ISR shape: this page reads searchParams
// (rev/path deep links), so it renders dynamically — cheap, because the
// manifest is served from a module LRU and the DB work is two row lookups.

const COMMIT_PAGE = 50;

interface Search {
  rev?: string | string[];
  path?: string | string[];
  diff?: string | string[];
}

const one = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

function repoHrefOf(canonical: string, name: string): string {
  return `/builds/${canonical}/repo/${encodeURIComponent(name)}`;
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ buildId: string; name: string }>;
  searchParams: Promise<Search>;
}): Promise<Metadata> {
  const { buildId, name: rawName } = await params;
  const sp = await searchParams;
  const parsed = parseBuildParam(buildId);
  if (!parsed) return {};
  const pool = getPool();
  const resolved = await resolveBuild(pool, parsed.hex, parsed.slug);
  if (!resolved) return {};
  const name = safeDecodeSegment(rawName);
  const repo = await getBuildRepo(pool, resolved.sha256, name);
  if (!repo) return {};

  const href = repoHrefOf(canonicalBuildId(resolved.sha256, resolved.name), name);
  const file = normalizeAssetPath(one(sp.path));
  const title = `${file ? `${file.split("/").pop()} · ` : ""}${name} · ${resolved.name}`;
  const description = `Source repository · ${repo.commit_count} commits · ${repo.head_ref ?? shortOid(repo.head_oid)}`;
  // The build's generated card; the file convention doesn't cascade here.
  const card = `/builds/${canonicalBuildId(resolved.sha256, resolved.name)}/opengraph-image`;
  return {
    title,
    description,
    alternates: { canonical: href },
    openGraph: { title, description, url: href, siteName: "Hidden Palace", images: [card] },
    twitter: { card: "summary_large_image" },
  };
}

// /builds/<id>/repo/<name> — browse an attached source repository: file tree,
// syntax-highlighted files, and revision history (global and per file), all
// answered from the attach-time manifest (no git at serve time). ?rev= and
// ?path= deep-link a revision and file; the client keeps them in sync.
export default async function RepoPage({
  params,
  searchParams,
}: {
  params: Promise<{ buildId: string; name: string }>;
  searchParams: Promise<Search>;
}) {
  const { buildId, name: rawName } = await params;
  const sp = await searchParams;
  const parsed = parseBuildParam(buildId);
  if (!parsed) notFound();
  const pool = getPool();
  const resolved = await resolveBuild(pool, parsed.hex, parsed.slug);
  if (!resolved) notFound();
  const canonical = canonicalBuildId(resolved.sha256, resolved.name);
  const name = safeDecodeSegment(rawName);
  if (buildId !== canonical) {
    const qs = new URLSearchParams();
    if (one(sp.rev)) qs.set("rev", one(sp.rev));
    if (one(sp.path)) qs.set("path", one(sp.path));
    if (one(sp.diff)) qs.set("diff", one(sp.diff));
    permanentRedirect(`${repoHrefOf(canonical, name)}${qs.size ? `?${qs}` : ""}`);
  }

  const repo = await getBuildRepo(pool, resolved.sha256, name);
  if (!repo) notFound();
  const buildHref = `/builds/${canonical}`;
  const repoHref = repoHrefOf(canonical, name);

  const idx = await loadRepo(repo.manifest_sha256);
  if (!idx) {
    // Rows travel with the DB; blobs sync separately — say so instead of 500ing.
    return (
      <main className="mx-auto max-w-none px-4 py-10 sm:px-8">
        <Link href={buildHref} className="text-sm text-neutral-500 hover:underline">
          &larr; {resolved.name}
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{name}</h1>
        <p className="mt-6 text-sm text-neutral-500">
          Repository data is not in the blob store on this host yet.
        </p>
      </main>
    );
  }

  const revParam = one(sp.rev);
  const revOid = resolveRev(idx, revParam);
  if (!revOid) notFound(); // garbage ?rev= deep links 404, like unknown paths elsewhere
  let path = normalizeAssetPath(one(sp.path)) || null;
  // A deep-linked directory just opens the tree; only files get a view.
  if (path && entryAt(idx, revOid, path)?.type === "tree") path = null;
  // A deep-linked diff: with a path, one file-history change; without, a
  // whole commit's change set. Resolved client-side, so only the shape is
  // validated here.
  const rawDiff = one(sp.diff).toLowerCase();
  const diff = /^[0-9a-f]{4,40}$/.test(rawDiff) ? rawDiff : null;

  // Initial payload, server-rendered: pruned tree (the build page's
  // RSC-payload discipline), first log page, and — when a file is deep-linked
  // — its per-file history (whose head entry is the version to display).
  const tree = buildTree(treeNodesAt(idx, revOid));
  const expanded = initialExpanded(tree);
  const counts = treeCounts(tree);
  const commits = commitsPage(idx, revOid, 0, COMMIT_PAGE);

  let initialLog: RepoLogEntryDto[] | null = null;
  if (path) {
    initialLog = fileLog(idx, revOid, path).map((e) => {
      const c = idx.commitByOid.get(e.oid)!;
      const b = e.blob ? idx.blobs.get(e.blob) : undefined;
      return {
        ...e,
        size: b ? b[1] : null,
        binary: b ? b[2] === 1 : false,
        author: c.author,
        committer: c.committer,
        message: c.message,
      };
    });
  }

  return (
    // Full-viewport at lg+: the page never scrolls or resizes with content —
    // each viewer panel scrolls internally instead (below lg it stacks and
    // the page scrolls normally).
    <main className="flex flex-col px-4 py-6 sm:px-8 lg:h-dvh lg:overflow-hidden">
      <Link href={buildHref} className="text-sm text-neutral-500 hover:underline">
        &larr; {resolved.name}
      </Link>

      {/* Links back to the viewer's root state (HEAD, commit log). */}
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        <Link href={repoHref} className="hover:underline">
          {name} <span className="text-base font-normal text-neutral-400">source repository</span>
        </Link>
      </h1>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
          {repo.commit_count} commits
        </span>
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono dark:bg-neutral-800">
          {repo.head_ref ?? shortOid(repo.head_oid)}
        </span>
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
          {counts.files} files at head
        </span>
      </div>

      <RepoViewer
        apiBase={`/api/repo/${repo.manifest_sha256}`}
        repoHref={repoHref}
        head={idx.manifest.head}
        headRef={idx.manifest.headRef}
        refs={idx.manifest.refs}
        initialRev={revParam}
        initialRevOid={revOid}
        initialPath={path}
        initialDiff={diff}
        initialRoots={pruneToExpanded(tree, expanded)}
        initialExpandedPaths={[...expanded]}
        initialTotal={commits.total}
        initialCommits={commits.commits}
        initialLog={initialLog}
      />
    </main>
  );
}
