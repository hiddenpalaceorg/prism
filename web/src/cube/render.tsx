// Server-side page rendering context for wiki pages: wires cube's renderer
// to the app's pool, URL scheme, and the HP component bindings.

import type { ReactNode } from "react";
import { parseDocument, type Cube } from "cube";
import { renderAst, type CubeRenderCtx } from "cube/react";
import { getPool } from "@/lib/db";
import { pageHref } from "./cube";
import { hpBindings } from "./registry";

export type RenderedWikiPage = {
  node: ReactNode;
  headings: { depth: number; text: string; id: string }[];
  parseFailed: boolean;
};

export async function renderWikiMarkdown(
  cube: Cube,
  page: { ns: string; slug: string; title: string },
  markdown: string,
): Promise<RenderedWikiPage> {
  const { root } = parseDocument(markdown);
  if (!root) {
    // Wikitext-fallback revisions and unparseable history render as source.
    return {
      node: (
        <pre className="whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 font-mono text-sm dark:border-neutral-800 dark:bg-neutral-900">
          {markdown}
        </pre>
      ),
      headings: [],
      parseFailed: true,
    };
  }

  const ctx: CubeRenderCtx = {
    registry: cube.registry,
    page,
    pageHref,
    bindings: hpBindings,
    interwiki: { tcrf: "https://tcrf.net/$1" },
    resolveLinks: async (refs) => {
      if (refs.length === 0) return new Map();
      const res = await getPool().query(
        `SELECT ns, slug FROM cube_page
          WHERE (ns, slug) IN (SELECT n, s FROM unnest($1::text[], $2::text[]) AS t(n, s))
            AND deleted_at IS NULL`,
        [refs.map((r) => r.ns), refs.map((r) => r.slug)],
      );
      const existing = new Set(res.rows.map((r) => `${r.ns}:${r.slug}`));
      return new Map(refs.map((r) => [`${r.ns}:${r.slug}`, existing.has(`${r.ns}:${r.slug}`)]));
    },
    resolveMedia: async (names) => {
      if (names.length === 0) return new Map();
      const res = await getPool().query(
        `SELECT name, storage_key FROM cube_media WHERE name = ANY($1) AND deleted_at IS NULL`,
        [names],
      );
      // Prefer the storage adapter's public gateway (files.hiddenpalace.org in
      // prod); otherwise stream through the app route (local dev).
      const found = new Map<string, string | null>(
        res.rows.map((r) => [
          r.name,
          cube.config.storage?.publicUrl(r.storage_key) ??
            `/api/cube/media/file?name=${encodeURIComponent(r.name)}`,
        ]),
      );
      return new Map(names.map((n) => [n, found.get(n) ?? null]));
    },
    runQuery: (q) => cube.api.queryObjects(q),
  };

  const rendered = await renderAst(root, ctx);
  return { node: rendered.node, headings: rendered.headings, parseFailed: false };
}
