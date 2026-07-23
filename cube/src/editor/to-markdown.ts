/**
 * TipTap/ProseMirror JSON doc -> mdast -> cube markdown.
 *
 * The inverse of from-mdast.ts. Component nodes become mdx-jsx elements with
 * attributes built by the same value rules as tags.ts serializeAttr (plain
 * string when quotable, strict-JSON brace expression otherwise), and
 * cubeUnknown/cubeRawBlock nodes emit their raw source verbatim (as mdast
 * html nodes, which mdast-util-to-markdown serializes untouched). Serializer
 * options mirror import/mediawiki/to-markdown.ts so all cube markdown looks
 * the same.
 */

import type {
  BlockContent,
  DefinitionContent,
  ListItem,
  PhrasingContent,
  Root,
  RootContent,
  Table as MdastTable,
  TableRow as MdastTableRow,
} from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import {
  mdxJsxToMarkdown,
  type MdxJsxAttribute,
  type MdxJsxFlowElement,
  type MdxJsxTextElement,
} from "mdast-util-mdx-jsx";
import { toMarkdown } from "mdast-util-to-markdown";
import type { WikiLink } from "../parse";
import type { ComponentSpec, Registry } from "../schema/index";
import type { PMDocJSON, PMMarkJSON, PMNodeJSON } from "./from-mdast";

/* ---- serializer ------------------------------------------------------------- */

/**
 * Serializes wikiLink nodes back to [[...]] syntax. Unlike the MediaWiki
 * importer's handler, an empty label is preserved as [[Target|]] (the MW
 * pipe trick) so round trips keep the AST identical.
 */
const wikiLinkToMarkdown = {
  handlers: {
    wikiLink(node: WikiLink): string {
      return node.label !== undefined ? `[[${node.target}|${node.label}]]` : `[[${node.target}]]`;
    },
  },
  unsafe: [],
};

/** Canonical cube markdown serialization (shared with raw-source fallbacks). */
export function serializeMdast(root: Root): string {
  return toMarkdown(root, {
    extensions: [gfmToMarkdown(), mdxJsxToMarkdown({ quote: '"' }), wikiLinkToMarkdown],
    bullet: "-",
    emphasis: "*",
    fences: true,
    rule: "-",
  });
}

export function docToMarkdown(doc: PMDocJSON, registry: Registry): string {
  return serializeMdast({ type: "root", children: blocksToFlow(doc.content ?? [], registry) });
}

/* ---- block content ------------------------------------------------------------ */

function blocksToFlow(nodes: PMNodeJSON[], registry: Registry): RootContent[] {
  const out: RootContent[] = [];
  for (const node of nodes) {
    const flow = blockToMdast(node, registry);
    if (flow !== null) out.push(flow);
  }
  return out;
}

function blockToMdast(node: PMNodeJSON, registry: Registry): RootContent | null {
  switch (node.type) {
    case "paragraph": {
      const children = inlineToPhrasing(node.content ?? [], registry);
      // Empty paragraphs (trailing node, placeholder fills) serialize to nothing.
      if (children.length === 0) return null;
      return { type: "paragraph", children };
    }
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      const depth = Math.min(6, Math.max(1, level)) as 1 | 2 | 3 | 4 | 5 | 6;
      return { type: "heading", depth, children: inlineToPhrasing(node.content ?? [], registry) };
    }
    case "codeBlock": {
      const lang = node.attrs?.language;
      return {
        type: "code",
        lang: typeof lang === "string" && lang !== "" ? lang : null,
        value: textOf(node),
      };
    }
    case "blockquote": {
      const children = blocksToFlow(node.content ?? [], registry);
      if (children.length === 0) return null;
      return { type: "blockquote", children: children as (BlockContent | DefinitionContent)[] };
    }
    case "bulletList":
      return {
        type: "list",
        ordered: false,
        spread: false,
        children: listItems(node.content ?? [], registry),
      };
    case "orderedList":
      return {
        type: "list",
        ordered: true,
        start: Number(node.attrs?.start ?? 1),
        spread: false,
        children: listItems(node.content ?? [], registry),
      };
    case "horizontalRule":
      return { type: "thematicBreak" };
    case "table":
      return tableToMdast(node, registry);
    case "cubeUnknown":
    case "cubeRawBlock":
      return { type: "html", value: String(node.attrs?.raw ?? "") };
    default:
      if (node.type.startsWith("cube_")) {
        return componentToMdast(node, registry) as unknown as RootContent;
      }
      return null;
  }
}

function listItems(nodes: PMNodeJSON[], registry: Registry): ListItem[] {
  return nodes
    .filter((n) => n.type === "listItem")
    .map((n) => ({
      type: "listItem" as const,
      spread: false,
      children: blocksToFlow(n.content ?? [], registry) as (BlockContent | DefinitionContent)[],
    }));
}

function textOf(node: PMNodeJSON): string {
  return (node.content ?? []).map((n) => n.text ?? "").join("");
}

function tableToMdast(node: PMNodeJSON, registry: Registry): MdastTable {
  const align = node.attrs?.align;
  const rows: MdastTableRow[] = (node.content ?? [])
    .filter((r) => r.type === "tableRow")
    .map((row) => ({
      type: "tableRow" as const,
      children: (row.content ?? [])
        .filter((c) => c.type === "tableCell" || c.type === "tableHeader")
        .map((cell) => ({ type: "tableCell" as const, children: cellPhrasing(cell, registry) })),
    }));
  return {
    type: "table",
    ...(Array.isArray(align) && { align: align as MdastTable["align"] }),
    children: rows,
  };
}

/** GFM cells hold phrasing only; multiple blocks in a cell join with spaces. */
function cellPhrasing(cell: PMNodeJSON, registry: Registry): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const block of cell.content ?? []) {
    const children = inlineToPhrasing(block.content ?? [], registry);
    if (children.length === 0) continue;
    if (out.length > 0) out.push({ type: "text", value: " " });
    out.push(...children);
  }
  return out;
}

/* ---- component nodes ------------------------------------------------------------ */

/** Same rule as tags.ts quotable(): when true, serializeAttr emits name="value". */
function quotable(v: string): boolean {
  return (!v.includes('"') && !v.includes("\n") && v === v.trim()) || v === "";
}

/** Attribute nodes in serializeComponentTag order and serializeAttr value form. */
function jsxAttributes(attrs: Record<string, unknown>, spec?: ComponentSpec): MdxJsxAttribute[] {
  const order: string[] = [];
  const seen = new Set<string>(["__children"]);
  if (spec) {
    for (const key of Object.keys(spec.attrs)) {
      if (key in attrs) {
        order.push(key);
        seen.add(key);
      }
    }
  }
  for (const key of Object.keys(attrs).filter((k) => !seen.has(k)).sort()) {
    order.push(key);
  }

  const out: MdxJsxAttribute[] = [];
  for (const key of order) {
    const value = attrs[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && quotable(value)) {
      out.push({ type: "mdxJsxAttribute", name: key, value });
    } else {
      out.push({
        type: "mdxJsxAttribute",
        name: key,
        value: { type: "mdxJsxAttributeValueExpression", value: JSON.stringify(value) },
      });
    }
  }
  return out;
}

function componentToMdast(
  node: PMNodeJSON,
  registry: Registry,
): MdxJsxFlowElement | MdxJsxTextElement {
  const name = node.type.slice("cube_".length);
  const spec = registry.get(name);
  const attrs = node.attrs ?? {};
  const attributes = jsxAttributes(attrs, spec);

  if (spec?.placement === "inline") {
    return { type: "mdxJsxTextElement", name, attributes, children: [] };
  }

  const policy = spec?.children ?? "none";
  const children: MdxJsxFlowElement["children"] = [];
  if (policy === "json") {
    const json = attrs.__children;
    if (typeof json === "string") {
      children.push({ type: "code", lang: "json", value: json });
    }
  } else if (policy === "markdown") {
    children.push(...(blocksToFlow(node.content ?? [], registry) as MdxJsxFlowElement["children"]));
  } else if (Array.isArray(policy)) {
    for (const child of node.content ?? []) {
      if (child.type.startsWith("cube_")) {
        children.push(componentToMdast(child, registry) as MdxJsxFlowElement);
      }
    }
  }
  return { type: "mdxJsxFlowElement", name, attributes, children };
}

/* ---- inline content ---------------------------------------------------------------- */

/** Outermost-first nesting order when rebuilding mark trees (code innermost). */
const MARK_PRIORITY: Record<string, number> = { link: 0, bold: 1, italic: 2, strike: 3, code: 4 };

function knownMarks(node: PMNodeJSON): PMMarkJSON[] {
  return (node.marks ?? []).filter((m) => m.type in MARK_PRIORITY);
}

function sameMark(a: PMMarkJSON, b: PMMarkJSON): boolean {
  return a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {});
}

function hasMark(node: PMNodeJSON, mark: PMMarkJSON): boolean {
  return knownMarks(node).some((m) => sameMark(m, mark));
}

function stripMark(node: PMNodeJSON, mark: PMMarkJSON): PMNodeJSON {
  return { ...node, marks: (node.marks ?? []).filter((m) => !sameMark(m, mark)) };
}

function inlineToPhrasing(nodes: PMNodeJSON[], registry: Registry): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let i = 0;
  while (i < nodes.length) {
    const marks = knownMarks(nodes[i]!);
    if (marks.length === 0) {
      const leaf = leafToPhrasing(nodes[i]!, registry);
      if (leaf !== null) out.push(leaf);
      i += 1;
      continue;
    }
    // Wrap the maximal run sharing the highest-priority mark, then recurse.
    const mark = marks.reduce((a, b) => (MARK_PRIORITY[a.type]! <= MARK_PRIORITY[b.type]! ? a : b));
    const run: PMNodeJSON[] = [];
    while (i < nodes.length && hasMark(nodes[i]!, mark)) {
      run.push(stripMark(nodes[i]!, mark));
      i += 1;
    }
    const wrapped = wrapMark(mark, run, registry);
    if (wrapped !== null) out.push(wrapped);
  }
  return out;
}

function wrapMark(mark: PMMarkJSON, run: PMNodeJSON[], registry: Registry): PhrasingContent | null {
  switch (mark.type) {
    case "bold":
      return { type: "strong", children: inlineToPhrasing(run, registry) };
    case "italic":
      return { type: "emphasis", children: inlineToPhrasing(run, registry) };
    case "strike":
      return { type: "delete", children: inlineToPhrasing(run, registry) };
    case "link":
      return {
        type: "link",
        url: String(mark.attrs?.href ?? ""),
        title: (mark.attrs?.title as string | null | undefined) ?? null,
        children: inlineToPhrasing(run, registry),
      };
    case "code": {
      const value = run.map((n) => n.text ?? "").join("");
      return value === "" ? null : { type: "inlineCode", value };
    }
    default:
      return null;
  }
}

function leafToPhrasing(node: PMNodeJSON, registry: Registry): PhrasingContent | null {
  switch (node.type) {
    case "text":
      return node.text === undefined || node.text === "" ? null : { type: "text", value: node.text };
    case "hardBreak":
      return { type: "break" };
    case "image":
      return {
        type: "image",
        url: String(node.attrs?.src ?? ""),
        alt: (node.attrs?.alt as string | null | undefined) ?? null,
        title: (node.attrs?.title as string | null | undefined) ?? null,
      };
    case "wikiLink": {
      const label = node.attrs?.label as string | null | undefined;
      const link: WikiLink = {
        type: "wikiLink",
        target: String(node.attrs?.target ?? ""),
        ...(label !== null && label !== undefined ? { label } : {}),
      };
      return link as unknown as PhrasingContent;
    }
    case "cubeUnknownInline":
      return { type: "html", value: String(node.attrs?.raw ?? "") };
    default:
      if (node.type.startsWith("cube_")) {
        return componentToMdast(node, registry) as unknown as PhrasingContent;
      }
      return null;
  }
}
