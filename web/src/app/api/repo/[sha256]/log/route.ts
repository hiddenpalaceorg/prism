import type { NextRequest } from "next/server";
import { entryAt, fileLog, resolveRev } from "@/lib/repo-manifest";
import { loadRepo, repoAttached } from "@/lib/repo";
import { normalizeAssetPath } from "@/lib/slug";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/repo/<manifest sha256>/log?rev=&path=<file> — the revisions of one
// path walking first parents from a revision, each joined with its commit's
// identity and message so the history panel needs a single fetch. Immutable
// per URL (content-addressed manifest).
const CACHE = "public, max-age=31536000, immutable";

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
  // Deleted files log fine (entry is null at rev); directories don't — their
  // "blob" would be a tree oid the blob route can't serve.
  if (entryAt(idx, rev, path)?.type === "tree") {
    return Response.json({ error: "path is a directory" }, { status: 400 });
  }

  // Entries carry their blob's size/binary flag too: the first entry *is* the
  // path's version at `rev` (or its deletion), so the file view needs no
  // second lookup.
  const entries = fileLog(idx, rev, path).map((e) => {
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
  return Response.json({ rev, path, entries }, { headers: { "Cache-Control": CACHE } });
}
