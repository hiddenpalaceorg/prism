import type { NextRequest } from "next/server";
import { commitChanges, resolveRev } from "@/lib/repo-manifest";
import { loadRepo, repoAttached } from "@/lib/repo";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/repo/<manifest sha256>/commit?rev=<rev> — one commit with every
// file it changed relative to its first parent (blob oids and size/binary
// joined in, so the overview can lazily diff each file without further
// lookups). Immutable per URL (content-addressed manifest).
const CACHE = "public, max-age=31536000, immutable";

export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  if (!(await repoAttached(sha256))) return Response.json({ error: "not found" }, { status: 404 });
  const idx = await loadRepo(sha256);
  if (!idx) return Response.json({ error: "repository data not in store" }, { status: 404 });

  const rev = resolveRev(idx, request.nextUrl.searchParams.get("rev") ?? "");
  if (!rev) return Response.json({ error: "unknown revision" }, { status: 404 });
  const commit = idx.commitByOid.get(rev)!;

  const changes = commitChanges(idx, rev).map((c) => {
    const from = c.from ? idx.blobs.get(c.from) : undefined;
    const to = c.to ? idx.blobs.get(c.to) : undefined;
    return {
      ...c,
      fromSize: from ? from[1] : null,
      toSize: to ? to[1] : null,
      binary: (from?.[2] ?? 0) === 1 || (to?.[2] ?? 0) === 1,
    };
  });

  return Response.json(
    {
      oid: rev,
      parents: commit.parents,
      author: commit.author,
      committer: commit.committer,
      message: commit.message,
      changes,
    },
    { headers: { "Cache-Control": CACHE } }
  );
}
