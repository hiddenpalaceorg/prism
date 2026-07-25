import type { NextRequest } from "next/server";
import { buildTree, findByPath, stubChildren } from "@/lib/filetree";
import { resolveRev, treeNodesAt } from "@/lib/repo-manifest";
import { loadRepo, repoAttached } from "@/lib/repo";
import { normalizeAssetPath } from "@/lib/slug";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/repo/<manifest sha256>/tree?rev=<rev>&path=<dir> — an attached
// repo's file tree at a revision: the full tree without `path`, one lazily
// expanded directory's children with it (same shapes as /api/build/.../tree,
// so the tree client code is shared thinking).
//
// The manifest is content-addressed and refs are frozen inside it, so every
// response for a given URL is immutable.
const CACHE = "public, max-age=31536000, immutable";

export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  if (!(await repoAttached(sha256))) return Response.json({ error: "not found" }, { status: 404 });
  const idx = await loadRepo(sha256);
  if (!idx) return Response.json({ error: "repository data not in store" }, { status: 404 });

  const rev = resolveRev(idx, request.nextUrl.searchParams.get("rev") ?? "");
  if (!rev) return Response.json({ error: "unknown revision" }, { status: 404 });

  const roots = buildTree(treeNodesAt(idx, rev));
  const path = request.nextUrl.searchParams.get("path");
  if (path == null || path === "") {
    return Response.json({ rev, roots }, { headers: { "Cache-Control": CACHE } });
  }
  const node = findByPath(roots, "/" + normalizeAssetPath(path));
  if (!node || !node.dir) return Response.json({ error: "no such directory" }, { status: 404 });
  return Response.json({ rev, children: stubChildren(node.children) }, { headers: { "Cache-Control": CACHE } });
}
