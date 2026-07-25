/**
 * The visual editor layer. INTERNAL: not a package entrypoint.
 *
 * TipTap is an implementation detail we expect to replace, so nothing
 * ProseMirror-shaped (node classes, PM document JSON) is part of cube's public
 * API - hosts consume the editor as `<WikiEditor>` from cube/react, whose
 * surface is markdown in, markdown out and survives an engine swap.
 * markdownToDoc/docToMarkdown are the seam that does not.
 *
 * The canonical round trip is:
 *   markdown -> parseDocument (mdast) -> mdastToDoc -> ProseMirror JSON
 *   ProseMirror JSON -> docToMarkdown -> markdown
 * Both directions are defined entirely by cube's own parser (parse.ts) and
 * serializer rules (tags.ts); TipTap's markdown support is not used.
 *
 * Everything here is client-safe: no database, HTTP, or Node-only imports.
 */

import type { Issue } from "../issues";
import { parseDocument } from "../parse";
import type { Registry } from "../schema/index";
import { mdastToDoc, type PMDocJSON } from "./from-mdast";

export { buildExtensions, type BuildExtensionsOptions } from "./extensions";
export { mdastToDoc, type PMDocJSON } from "./from-mdast";
export { docToMarkdown } from "./to-markdown";
// Re-exported so client code can build a registry without importing the
// server-side "cube" root module.
export { builtinComponents } from "../builtins";

export type MarkdownToDocResult = {
  /** null when the markdown has hard parse errors (see issues). */
  doc: PMDocJSON | null;
  issues: Issue[];
};

/** parseDocument + mdastToDoc: markdown straight to an editor document. */
export function markdownToDoc(markdown: string, registry: Registry): MarkdownToDocResult {
  const { root, issues } = parseDocument(markdown);
  if (!root) return { doc: null, issues };
  return { doc: mdastToDoc(root, registry, markdown), issues };
}
