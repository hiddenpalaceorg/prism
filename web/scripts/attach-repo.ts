// Attach a git repository (typically a VSS->git conversion) to an existing
// build as a browsable source-repo asset.
// Usage: npm run attach-repo -- --build <sha256 or 8+ hex prefix> --repo <path>
//        [--name <name>] [--all-refs] [--force]        (env DATABASE_URL, ASSET_STORE_DIR)
//
// Reads the .git repo with isomorphic-git (pure JS — no git binary anywhere in
// the pipeline), writes every unique git blob's content into the asset store
// (content-addressed by sha256, so identical file versions dedup for free),
// emits a manifest blob (see src/lib/repo-manifest.ts), and records the
// attachment in build_repo. The web app serves the viewer from the manifest +
// store alone. Re-running is idempotent on blobs; the row needs --force.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import git from "isomorphic-git";
import pg from "pg";
import { assetBlobPath, assetStoreDir } from "../src/lib/assets";
import { resolveBuild } from "../src/lib/queries";
import { buildHref } from "../src/lib/slug";
import {
  REPO_MANIFEST_VERSION,
  REPO_NAME_RE,
  type RepoBlobInfo,
  type RepoCommit,
  type RepoIdent,
  type RepoManifest,
  type RepoTreeEntry,
} from "../src/lib/repo-manifest";

// Guards against pathological commit messages; VSS comments are tiny.
const MAX_MESSAGE_CHARS = 10_000;
// Beyond this the manifest still works (the server LRU-caches the parsed
// form), but a v2 format with interned oids would be worth building.
const MANIFEST_WARN_BYTES = 50_000_000;

function usage(): never {
  console.error(
    "usage: tsx scripts/attach-repo.ts --build <sha256 or 8+ hex prefix> --repo <path> [--name <name>] [--all-refs] [--force]"
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const opts = { build: "", repo: "", name: "", allRefs: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--build") opts.build = argv[++i] ?? "";
    else if (a === "--repo") opts.repo = argv[++i] ?? "";
    else if (a === "--name") opts.name = argv[++i] ?? "";
    else if (a === "--all-refs") opts.allRefs = true;
    else if (a === "--force") opts.force = true;
    else {
      console.error(`unknown argument: ${a}`);
      usage();
    }
  }
  if (!opts.build || !opts.repo) usage();
  return opts;
}

/** Resolve a repo path (work tree, bare repo, or .git-file pointer) to the
 *  actual gitdir isomorphic-git should read. */
function findGitdir(repoPath: string): string {
  const dotGit = path.join(repoPath, ".git");
  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(dotGit);
  } catch {
    // no .git — maybe bare
  }
  if (st?.isDirectory()) return dotGit;
  if (st?.isFile()) {
    // Worktree pointer file: "gitdir: <target>"
    const m = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
    if (m) return path.resolve(repoPath, m[1]);
  }
  if (fs.existsSync(path.join(repoPath, "HEAD")) && fs.existsSync(path.join(repoPath, "objects"))) {
    return repoPath; // bare repo
  }
  console.error(`${repoPath} is not a git repository`);
  process.exit(1);
}

/** Follow annotated-tag chains down to a commit oid; null when the ref
 *  ultimately points at something else (e.g. a tagged tree). */
async function peelToCommit(
  fsArg: typeof fs,
  gitdir: string,
  cache: object,
  oid: string
): Promise<string | null> {
  for (let hops = 0; hops < 10; hops++) {
    try {
      const c = await git.readCommit({ fs: fsArg, gitdir, oid, cache });
      return c.oid;
    } catch {
      try {
        const t = await git.readTag({ fs: fsArg, gitdir, oid, cache });
        oid = t.tag.object;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Staged write into the content-addressed store (the ingest.ts idiom): a
 *  crash can't leave a truncated blob under its final name. */
function storeBlob(sha256: string, data: Uint8Array): boolean {
  const dest = assetBlobPath(sha256);
  if (fs.existsSync(dest)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dest);
  return true;
}

const ident = (i: { name: string; email: string; timestamp: number; timezoneOffset: number }): RepoIdent => ({
  name: i.name,
  email: i.email,
  time: i.timestamp,
  tz: i.timezoneOffset,
});

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const hex = opts.build.toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(hex)) {
    console.error("--build must be a sha256 or an 8+ char hex prefix of one");
    process.exit(1);
  }

  const repoPath = path.resolve(opts.repo);
  const gitdir = findGitdir(repoPath);
  const name = opts.name || path.basename(repoPath).replace(/\.git$/, "");
  if (!REPO_NAME_RE.test(name)) {
    console.error(`repo name "${name}" is not URL-safe (${REPO_NAME_RE}); pass --name`);
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || "postgres:///curator_test",
  });
  try {
    // Fail fast on identity questions before any repo walking.
    const build = await resolveBuild(pool, hex, null);
    if (!build) {
      console.error(`no unique build matches "${hex}"`);
      process.exit(1);
    }
    if (!opts.force) {
      const existing = await pool.query(
        "SELECT 1 FROM build_repo WHERE build_sha256=$1 AND name=$2",
        [build.sha256, name]
      );
      if (existing.rows.length) {
        console.error(`repo "${name}" is already attached to ${build.name} — pass --force to replace`);
        process.exit(1);
      }
    }

    // isomorphic-git's cache memoizes packfile indexes across the thousands of
    // object reads below — without it every read re-parses the pack.
    const cache = {};

    let head: string;
    try {
      head = await git.resolveRef({ fs, gitdir, ref: "HEAD" });
    } catch {
      console.error(`${repoPath} has no commits`);
      process.exit(1);
    }
    const headRef = (await git.currentBranch({ fs, gitdir, fullname: false })) ?? null;

    // Branches then tags, name-sorted; annotated tags peeled to their commits.
    const refs: { name: string; oid: string }[] = [];
    const branchNames = (await git.listBranches({ fs, gitdir })).sort();
    const tagNames = (await git.listTags({ fs, gitdir })).sort();
    for (const [names, kind] of [
      [branchNames, "branch"],
      [tagNames, "tag"],
    ] as const) {
      for (const refName of names) {
        const raw = await git.resolveRef({ fs, gitdir, ref: refName }).catch(() => null);
        const oid = raw && (await peelToCommit(fs, gitdir, cache, raw));
        if (oid) refs.push({ name: refName, oid });
        else console.warn(`skipping unresolvable ${kind} ${refName}`);
      }
    }

    // Commit walk: BFS over parents from HEAD (or every ref with --all-refs).
    const seeds = opts.allRefs ? [head, ...refs.map((r) => r.oid)] : [head];
    const commitByOid = new Map<string, RepoCommit>();
    const stack = [...seeds];
    while (stack.length) {
      const oid = stack.pop()!;
      if (commitByOid.has(oid)) continue;
      const { commit } = await git.readCommit({ fs, gitdir, oid, cache });
      commitByOid.set(oid, {
        oid,
        tree: commit.tree,
        parents: commit.parent,
        author: ident(commit.author),
        committer: ident(commit.committer),
        message: commit.message.slice(0, MAX_MESSAGE_CHARS),
      });
      stack.push(...commit.parent.filter((p) => !commitByOid.has(p)));
    }
    // Newest-first, deterministically (same repo -> byte-identical manifest).
    const commits = [...commitByOid.values()].sort(
      (a, b) => b.committer.time - a.committer.time || (a.oid < b.oid ? -1 : 1)
    );
    // Without --all-refs a ref can point outside the walked history; the
    // manifest must stay self-contained.
    const kept = refs.filter((r) => commitByOid.has(r.oid));
    for (const r of refs) {
      if (!commitByOid.has(r.oid)) console.warn(`ref ${r.name} not reachable from HEAD — dropped (use --all-refs)`);
    }

    // Tree walk: consecutive commits share almost all subtrees, so the visited
    // set is what keeps this linear in the number of *unique* trees.
    const trees: Record<string, RepoTreeEntry[]> = {};
    const blobOids = new Set<string>();
    let gitlinks = 0;
    const treeStack = commits.map((c) => c.tree);
    while (treeStack.length) {
      const oid = treeStack.pop()!;
      if (trees[oid]) continue;
      const { tree } = await git.readTree({ fs, gitdir, oid, cache });
      const entries: RepoTreeEntry[] = [];
      for (const e of tree) {
        if (e.type === "commit") {
          gitlinks++; // submodule pointer — nothing behind it in this repo
          continue;
        }
        entries.push([e.path, e.type, e.oid]);
        if (e.type === "tree") {
          if (!trees[e.oid]) treeStack.push(e.oid);
        } else {
          blobOids.add(e.oid);
        }
      }
      trees[oid] = entries;
    }
    if (gitlinks > 0) console.warn(`dropped ${gitlinks} submodule (gitlink) entries`);

    // Blob pass: content into the store, one blob in memory at a time.
    const blobs: Record<string, RepoBlobInfo> = {};
    let written = 0;
    let done = 0;
    for (const oid of [...blobOids].sort()) {
      const { blob } = await git.readBlob({ fs, gitdir, oid, cache });
      const sha256 = createHash("sha256").update(blob).digest("hex");
      // Git's own binary heuristic: a NUL byte in the head of the file.
      const binary = blob.subarray(0, 8000).includes(0) ? 1 : 0;
      if (storeBlob(sha256, blob)) written++;
      blobs[oid] = [sha256, blob.length, binary];
      if (++done % 500 === 0) console.log(`  blobs: ${done}/${blobOids.size}`);
    }

    const manifest: RepoManifest = {
      version: REPO_MANIFEST_VERSION,
      name,
      head,
      headRef,
      refs: kept,
      commits,
      trees,
      blobs,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
    if (manifestBytes.length > MANIFEST_WARN_BYTES) {
      console.warn(
        `manifest is ${(manifestBytes.length / 1e6).toFixed(0)}MB — consider a v2 interned format before attaching many repos this size`
      );
    }
    storeBlob(manifestSha, manifestBytes);

    await pool.query(
      `INSERT INTO build_repo (build_sha256, name, manifest_sha256, head_oid, head_ref, commit_count)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (build_sha256, name) DO UPDATE
         SET manifest_sha256=EXCLUDED.manifest_sha256, head_oid=EXCLUDED.head_oid,
             head_ref=EXCLUDED.head_ref, commit_count=EXCLUDED.commit_count, created_at=now()`,
      [build.sha256, name, manifestSha, head, headRef, commits.length]
    );

    console.log(`attached "${name}" to ${build.name} (${build.sha256.slice(0, 10)})`);
    console.log(
      `  ${commits.length} commits, ${Object.keys(trees).length} trees, ${blobOids.size} blobs (${written} new in ${assetStoreDir()})`
    );
    console.log(`  manifest ${manifestSha} (${(manifestBytes.length / 1024).toFixed(0)}KB)`);
    console.log(`  ${buildHref(build.sha256, build.name)}/repo/${encodeURIComponent(name)}`);
    console.log(`  note: the build page card is ISR-cached — allow up to an hour on prod, or restart`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
