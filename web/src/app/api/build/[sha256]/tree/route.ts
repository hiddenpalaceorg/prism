import type { NextRequest } from "next/server";
import { unstable_cache } from "next/cache";
import { getPool } from "@/lib/db";
import { buildTree, findByPath, stubChildren, type TreeNode } from "@/lib/filetree";
import { getBuild } from "@/lib/queries";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/build/<sha256>/tree?path=<dir path> — that directory's children,
// one level deep (child dirs are stubs with subtree aggregates; the FileTree
// client fetches each level on expand).
// GET /api/build/<sha256>/tree — the full tree (the "Expand all" path).
//
// A build's tree only changes on re-ingest, so responses are safe to cache.
const CACHE = "public, max-age=3600";

// Expanding folder after folder of the same build would otherwise re-fetch and
// re-parse the full record (8MB+ for the biggest builds) per click. Tagged
// per build so a re-ingest can revalidate one build's tree (see /api/refresh).
const getTree = (sha256: string) =>
  unstable_cache(
    async (): Promise<TreeNode[] | null> => {
      const build = await getBuild(getPool(), sha256);
      return build ? buildTree(build.record.contents) : null;
    },
    ["build-tree", sha256],
    { revalidate: 3600, tags: [`build-tree:${sha256}`] }
  )();

export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const roots = await getTree(sha256);
  if (!roots) return Response.json({ error: "not found" }, { status: 404 });
  const path = request.nextUrl.searchParams.get("path");
  if (path == null || path === "") {
    return Response.json({ roots }, { headers: { "Cache-Control": CACHE } });
  }

  const node = findByPath(roots, path);
  if (!node || !node.dir) return Response.json({ error: "no such directory" }, { status: 404 });
  return Response.json({ children: stubChildren(node.children) }, { headers: { "Cache-Control": CACHE } });
}
