import { readFile } from "node:fs/promises";
import type { NextRequest } from "next/server";
import { assetBlobPath } from "@/lib/assets";
import { blameLines, type BlameCommitDto } from "@/lib/blame";
import { entryAt, fileLog, commitSubject, resolveRev } from "@/lib/repo-manifest";
import { loadRepo, repoAttached } from "@/lib/repo";
import { normalizeAssetPath } from "@/lib/slug";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/repo/<manifest sha256>/blame?rev=&path=<file> — per-line blame of
// one path at a revision, replayed from its first-parent history (the same
// chain the log route serves). Immutable per URL (content-addressed manifest);
// the client keys the fetch on the head log entry's oid, so revisions that
// share a file version share the cached response.
const CACHE = "public, max-age=31536000, immutable";

// The file view caps display at 1MB, so a bigger head has no lines to blame
// against; the total bound keeps one request from diffing an unbounded chain.
const HEAD_CAP = 1_000_000;
const TOTAL_CAP = 32_000_000;

export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  if (!(await repoAttached(sha256))) return Response.json({ error: "not found" }, { status: 404 });
  const idx = await loadRepo(sha256);
  if (!idx) return Response.json({ error: "repository data not in store" }, { status: 404 });

  const params = request.nextUrl.searchParams;
  const rev = resolveRev(idx, params.get("rev") ?? "");
  if (!rev) return Response.json({ error: "unknown revision" }, { status: 404 });
  const path = normalizeAssetPath(params.get("path") ?? "");
  if (!path) return Response.json({ error: "path required" }, { status: 400 });
  if (entryAt(idx, rev, path)?.type === "tree") {
    return Response.json({ error: "path is a directory" }, { status: 400 });
  }

  const entries = fileLog(idx, rev, path);
  const head = entries[0];
  if (!head || !head.blob) {
    return Response.json({ error: "no file at this revision" }, { status: 404 });
  }
  const headInfo = idx.blobs.get(head.blob)!;
  if (headInfo[2] === 1) return Response.json({ error: "binary file" }, { status: 400 });
  if (headInfo[1] > HEAD_CAP) return Response.json({ error: "file too large" }, { status: 400 });
  let total = 0;
  for (const e of entries) if (e.blob) total += idx.blobs.get(e.blob)![1];
  if (total > TOTAL_CAP) return Response.json({ error: "history too large" }, { status: 400 });

  // Oldest first: blameLines replays the chain forward. A delete along the
  // way is an empty version, so a re-add blames every line on the re-adding
  // commit — the first-parent story, same as the history panel tells.
  const chain = [...entries].reverse();
  let versions: string[];
  try {
    versions = await Promise.all(
      chain.map((e) => (e.blob ? readFile(assetBlobPath(idx.blobs.get(e.blob)![0]), "utf8") : ""))
    );
  } catch {
    // Row + manifest landed but some blob hasn't synced to this host yet.
    return Response.json({ error: "blob bytes not in store" }, { status: 404 });
  }

  const commits: BlameCommitDto[] = chain.map((e) => {
    const c = idx.commitByOid.get(e.oid)!;
    return { oid: e.oid, author: c.author, subject: commitSubject(c.message) };
  });
  const lines = blameLines(versions);
  return Response.json({ rev, path, commits, lines }, { headers: { "Cache-Control": CACHE } });
}
