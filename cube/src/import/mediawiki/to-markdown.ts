/**
 * hast (rewritten Parsoid HTML) -> mdast -> cube markdown.
 *
 * The pipeline (convert.ts) replaces transclusion groups with placeholder
 * elements before this stage:
 *   <cube-component data-name data-attrs data-placement data-children-json>
 *   <cube-markdown data-markdown>     (pre-serialized markdown, spliced in)
 *   <cube-verbatim data-wikitext>     (unconvertible; fenced wikitext block)
 * Everything else converts through hast-util-to-mdast with wiki-aware
 * handlers (wiki links, media images), then serializes canonically.
 */

import type { Element as HastElement, Nodes as HastNodes } from "hast";
import type { Code, Node, Root, Text } from "mdast";
import type {
  MdxJsxAttribute,
  MdxJsxFlowElement,
  MdxJsxTextElement,
} from "mdast-util-mdx-jsx";
import { toMdast, type Handle, type State } from "hast-util-to-mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfmToMarkdown } from "mdast-util-gfm";
import { mdxJsxToMarkdown } from "mdast-util-mdx-jsx";
import { parseDocument, type WikiLink } from "../../parse";

/* ---- placeholder -> mdx jsx ------------------------------------------------ */

export function componentPlaceholder(
  name: string,
  attrs: Record<string, unknown>,
  placement: "block" | "inline",
  childrenJson?: unknown,
): HastElement {
  return {
    type: "element",
    tagName: "cube-component",
    properties: {
      dataName: name,
      dataAttrs: JSON.stringify(attrs),
      dataPlacement: placement,
      ...(childrenJson !== undefined && { dataChildrenJson: JSON.stringify(childrenJson) }),
    },
    children: [],
  };
}

export function markdownPlaceholder(markdown: string): HastElement {
  return {
    type: "element",
    tagName: "cube-markdown",
    properties: { dataMarkdown: markdown },
    children: [],
  };
}

export function verbatimPlaceholder(wikitext: string): HastElement {
  return {
    type: "element",
    tagName: "cube-verbatim",
    properties: { dataWikitext: wikitext },
    children: [],
  };
}

function jsxAttributes(attrs: Record<string, unknown>): MdxJsxAttribute[] {
  const out: MdxJsxAttribute[] = [];
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.includes('"') && !value.includes("\n")) {
      out.push({ type: "mdxJsxAttribute", name, value });
    } else {
      out.push({
        type: "mdxJsxAttribute",
        name,
        value: {
          type: "mdxJsxAttributeValueExpression",
          value: JSON.stringify(value),
        },
      });
    }
  }
  return out;
}

function componentHandler(state: State, node: HastElement): Node | Node[] | undefined {
  const props = node.properties as Record<string, unknown>;
  const name = String(props.dataName ?? "");
  const attrs = JSON.parse(String(props.dataAttrs ?? "{}")) as Record<string, unknown>;
  const placement = props.dataPlacement === "inline" ? "inline" : "block";
  const attributes = jsxAttributes(attrs);

  if (placement === "inline") {
    const el: MdxJsxTextElement = { type: "mdxJsxTextElement", name, attributes, children: [] };
    return el as unknown as Node;
  }

  const children: MdxJsxFlowElement["children"] = [];
  if (props.dataChildrenJson !== undefined) {
    const pretty = JSON.stringify(JSON.parse(String(props.dataChildrenJson)), null, 1);
    children.push({ type: "code", lang: "json", value: pretty } as Code);
  }
  const el: MdxJsxFlowElement = { type: "mdxJsxFlowElement", name, attributes, children };
  void state;
  return el as unknown as Node;
}

function markdownHandler(_state: State, node: HastElement): Node | Node[] | undefined {
  const markdown = String((node.properties as Record<string, unknown>).dataMarkdown ?? "");
  const { root } = parseDocument(markdown);
  if (!root) {
    return { type: "code", lang: "text", value: markdown } as Code;
  }
  return root.children as unknown as Node[];
}

function verbatimHandler(_state: State, node: HastElement): Node {
  const wikitext = String((node.properties as Record<string, unknown>).dataWikitext ?? "");
  return { type: "code", lang: "wikitext", value: wikitext } as Code;
}

/* ---- wiki links + media images --------------------------------------------- */

/** "./Sonic_the_Hedgehog_2" or "./File:X.png" -> decoded title. */
export function titleFromParsoidHref(href: string): string | null {
  if (!href.startsWith("./")) return null;
  const raw = href.slice(2).split("#")[0]!;
  try {
    return decodeURIComponent(raw).replace(/_/g, " ");
  } catch {
    return raw.replace(/_/g, " ");
  }
}

function anchorHandler(state: State, node: HastElement): Node | Node[] | undefined {
  const rel = String(node.properties?.rel ?? "");
  const href = String(node.properties?.href ?? "");

  if (/\bmw:WikiLink\b/.test(rel)) {
    const title = titleFromParsoidHref(href);
    if (title !== null) {
      const label = textContent(node);
      // SMW inline annotations ([[Has prop::value| ]]) are data, not links:
      // keep only the visible label text (usually blank).
      if (title.includes("::")) {
        return label.trim() === "" ? undefined : ({ type: "text", value: label } as Node);
      }
      const link: WikiLink = {
        type: "wikiLink",
        target: title,
        ...(label !== title && label !== "" ? { label } : {}),
      };
      return link as unknown as Node;
    }
  }
  if (/\bmw:ExtLink\b/.test(rel) || /^https?:/.test(href)) {
    return { type: "link", url: href, children: state.all(node) } as unknown as Node;
  }
  // Other rels (mw:MediaLink etc.): keep the text.
  return state.all(node) as Node[];
}

function textContent(node: HastNodes): string {
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map(textContent).join("");
  return "";
}

/** Media (typeof mw:File / mw:Image figures and spans) -> markdown image. */
function fileHandler(state: State, node: HastElement): Node | Node[] | undefined {
  const inner = findFileLink(node);
  if (!inner) return state.all(node) as Node[];
  const caption = captionOf(node);
  return {
    type: "image",
    url: `media:${inner}`,
    alt: caption ?? inner,
  } as unknown as Node;
}

function findFileLink(node: HastElement): string | null {
  let found: string | null = null;
  const walk = (n: HastNodes): void => {
    if (found) return;
    if (n.type === "element") {
      const href = String(n.properties?.href ?? "");
      const title = titleFromParsoidHref(href);
      if (title && /^(File|Media):/i.test(title)) {
        found = title.replace(/^(File|Media):/i, "");
        return;
      }
      const resource = String((n.properties as Record<string, unknown>)?.resource ?? "");
      const rtitle = titleFromParsoidHref(resource);
      if (rtitle && /^(File|Media):/i.test(rtitle)) {
        found = rtitle.replace(/^(File|Media):/i, "");
        return;
      }
      n.children.forEach(walk);
    }
  };
  walk(node);
  return found;
}

function captionOf(node: HastElement): string | null {
  const cap = node.children.find((c) => c.type === "element" && c.tagName === "figcaption");
  if (!cap) return null;
  const text = textContent(cap).trim();
  return text === "" ? null : text;
}

function isFileNode(node: HastElement): boolean {
  const typeofAttr = String(node.properties?.typeOf ?? node.properties?.typeof ?? "");
  return /\bmw:(File|Image)\b/.test(typeofAttr);
}

/* ---- conversion ------------------------------------------------------------- */

export interface HastToMarkdownResult {
  markdown: string;
  /** True when the output contains colspan/rowspan tables (flattened by GFM). */
  lostTableAttrs: boolean;
}

export function hastToMarkdown(root: HastNodes): HastToMarkdownResult {
  let lostTableAttrs = false;
  scanTables(root, () => {
    lostTableAttrs = true;
  });
  // Wikitext comments are invisible non-content in MediaWiki; cube's parser
  // rejects <!-- --> outright, so they must never reach the markdown.
  stripComments(root);

  // Handlers return our custom wikiLink/mdx nodes, which sit outside
  // hast-util-to-mdast's closed mdast union; the casts are the seam.
  const mdast = toMdast(root, {
    handlers: {
      "cube-component": componentHandler as unknown as Handle,
      "cube-markdown": markdownHandler as unknown as Handle,
      "cube-verbatim": verbatimHandler as unknown as Handle,
      a: anchorHandler as unknown as Handle,
      figure: ((state: State, node: HastElement) =>
        isFileNode(node) ? fileHandler(state, node) : undefined) as unknown as Handle,
      span: ((state: State, node: HastElement) =>
        isFileNode(node) ? fileHandler(state, node) : (state.all(node) as Node[])) as unknown as Handle,
      // Parsoid metadata that must never leak into content:
      link: () => undefined,
      style: () => undefined,
      meta: () => undefined,
      base: () => undefined,
      title: () => undefined,
    },
  }) as Root;

  const markdown = toMarkdown(mdast, {
    extensions: [gfmToMarkdown(), mdxJsxToMarkdown({ quote: '"' }), wikiLinkToMarkdown],
    bullet: "-",
    emphasis: "*",
    fences: true,
    rule: "-",
  });

  return { markdown, lostTableAttrs };
}

function stripComments(node: HastNodes): void {
  if ("children" in node) {
    const parent = node as { children: HastNodes[] };
    parent.children = parent.children.filter((c) => c.type !== "comment");
    parent.children.forEach(stripComments);
  }
}

function scanTables(node: HastNodes, onLoss: () => void): void {
  if (node.type === "element") {
    if (node.tagName === "td" || node.tagName === "th") {
      const p = node.properties as Record<string, unknown>;
      if (p.colSpan !== undefined || p.rowSpan !== undefined) onLoss();
    }
    node.children.forEach((c) => scanTables(c, onLoss));
  } else if ("children" in node) {
    (node.children as HastNodes[]).forEach((c) => scanTables(c, onLoss));
  }
}

/** toMarkdown extension serializing wikiLink nodes back to [[...]] syntax. */
const wikiLinkToMarkdown = {
  handlers: {
    wikiLink(node: WikiLink): string {
      return node.label !== undefined && node.label !== ""
        ? `[[${node.target}|${node.label}]]`
        : `[[${node.target}]]`;
    },
  },
  unsafe: [],
};

/** Blank text used when removing nodes in-place. */
export const EMPTY_TEXT: Text = { type: "text", value: "" };
