/**
 * Canonical mdast (cube parseDocument output) -> TipTap/ProseMirror JSON doc.
 *
 * Never fails; it degrades. Anything the editor schema cannot represent
 * becomes a cubeUnknown / cubeRawBlock node carrying the raw source (sliced
 * from the original markdown via node positions when available, otherwise
 * re-serialized through the canonical serializer), so the round trip defined
 * by parseDocument + to-markdown.ts stays lossless.
 */

import type {
  Code,
  List,
  PhrasingContent,
  Root,
  RootContent,
  Table as MdastTable,
} from "mdast";
import type { MdxJsxFlowElement, MdxJsxTextElement } from "mdast-util-mdx-jsx";
import type { Node as UnistNode } from "unist";
import { isComponentName, rawAttrs } from "../mdx";
import type { WikiLink } from "../parse";
import type { Registry } from "../schema/index";
import { serializeMdast } from "./to-markdown";

/* ---- ProseMirror JSON shapes ------------------------------------------------ */

export type PMMarkJSON = {
  type: string;
  attrs?: Record<string, unknown>;
};

export type PMNodeJSON = {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: PMMarkJSON[];
  content?: PMNodeJSON[];
  text?: string;
};

export type PMDocJSON = {
  type: "doc";
  content: PMNodeJSON[];
};

/* ---- entry ------------------------------------------------------------------- */

type Ctx = {
  registry: Registry;
  source?: string;
};

export function mdastToDoc(root: Root, registry: Registry, source?: string): PMDocJSON {
  const ctx: Ctx = { registry, ...(source !== undefined && { source }) };
  const content = flowToBlocks(root.children, ctx);
  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

/* ---- raw-source fallbacks ------------------------------------------------------ */

function rawOf(node: UnistNode, ctx: Ctx): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (ctx.source !== undefined && start !== undefined && end !== undefined) {
    return ctx.source.slice(start, end);
  }
  return serializeMdast({ type: "root", children: [node as RootContent] }).trimEnd();
}

function rawBlock(node: UnistNode, ctx: Ctx): PMNodeJSON {
  return { type: "cubeRawBlock", attrs: { raw: rawOf(node, ctx) } };
}

function unknownInline(node: UnistNode, ctx: Ctx): PMNodeJSON {
  return { type: "cubeUnknownInline", attrs: { raw: rawOf(node, ctx) } };
}

/* ---- flow (block) content ------------------------------------------------------ */

/** ProseMirror "block+" holes need at least one child. */
function nonEmpty(blocks: PMNodeJSON[]): PMNodeJSON[] {
  return blocks.length > 0 ? blocks : [{ type: "paragraph" }];
}

function flowToBlocks(nodes: RootContent[], ctx: Ctx): PMNodeJSON[] {
  const out: PMNodeJSON[] = [];
  for (const node of nodes) {
    const block = flowNode(node, ctx);
    if (block !== null) out.push(block);
  }
  return out;
}

function flowNode(node: RootContent, ctx: Ctx): PMNodeJSON | null {
  switch (node.type) {
    case "paragraph": {
      const content = inlineToNodes(node.children, ctx, []);
      return { type: "paragraph", ...(content.length > 0 && { content }) };
    }
    case "heading": {
      const content = inlineToNodes(node.children, ctx, []);
      return {
        type: "heading",
        attrs: { level: node.depth },
        ...(content.length > 0 && { content }),
      };
    }
    case "code": {
      // Fence meta has no editor representation; preserve the block verbatim.
      if (node.meta) return rawBlock(node, ctx);
      return {
        type: "codeBlock",
        attrs: { language: node.lang ?? null },
        ...(node.value !== "" && { content: [{ type: "text", text: node.value }] }),
      };
    }
    case "blockquote":
      return { type: "blockquote", content: nonEmpty(flowToBlocks(node.children, ctx)) };
    case "list":
      return listNode(node, ctx);
    case "thematicBreak":
      return { type: "horizontalRule" };
    case "table":
      return tableNode(node, ctx);
    case "html":
      return { type: "cubeRawBlock", attrs: { raw: node.value } };
    case "mdxJsxFlowElement": {
      const converted = componentNodeJson(node, ctx);
      if (converted.kind === "raw") return { type: "cubeUnknown", attrs: { raw: converted.raw } };
      // An inline-placement component written at flow level: wrap it. The
      // serializer emits it back on its own line, which re-parses as flow.
      if (converted.inline) return { type: "paragraph", content: [converted.node] };
      return converted.node;
    }
    default:
      // definitions, footnotes, stray phrasing, ...: preserve verbatim.
      return rawBlock(node, ctx);
  }
}

function listNode(node: List, ctx: Ctx): PMNodeJSON {
  // GFM task lists have no editor node; preserve the whole list verbatim.
  if (node.children.some((li) => li.checked !== null && li.checked !== undefined)) {
    return rawBlock(node, ctx);
  }
  const items: PMNodeJSON[] = node.children.map((li) => ({
    type: "listItem",
    content: nonEmpty(flowToBlocks(li.children, ctx)),
  }));
  return node.ordered
    ? { type: "orderedList", attrs: { start: node.start ?? 1 }, content: items }
    : { type: "bulletList", content: items };
}

function tableNode(node: MdastTable, ctx: Ctx): PMNodeJSON {
  const rows: PMNodeJSON[] = node.children.map((row, r) => ({
    type: "tableRow",
    content: row.children.map((cell) => {
      const content = inlineToNodes(cell.children, ctx, []);
      return {
        type: r === 0 ? "tableHeader" : "tableCell",
        content: [{ type: "paragraph", ...(content.length > 0 && { content }) }],
      };
    }),
  }));
  return { type: "table", attrs: { align: node.align ?? null }, content: rows };
}

/* ---- component tags -------------------------------------------------------------- */

type ComponentResult =
  | { kind: "node"; node: PMNodeJSON; inline: boolean }
  | { kind: "raw"; raw: string };

function componentNodeJson(el: MdxJsxFlowElement | MdxJsxTextElement, ctx: Ctx): ComponentResult {
  const raw = (): ComponentResult => ({ kind: "raw", raw: rawOf(el, ctx) });

  // Fragments (<>) and lowercase intrinsic tags are not components.
  if (!isComponentName(el.name)) return raw();
  const spec = ctx.registry.get(el.name);
  if (!spec) return raw();

  const { attrs, errors } = rawAttrs(el);
  if (errors.length > 0) return raw();
  for (const key of Object.keys(attrs)) {
    if (!(key in spec.attrs)) return raw();
  }

  const values: Record<string, unknown> = {};
  for (const key of Object.keys(spec.attrs)) values[key] = key in attrs ? attrs[key]! : null;

  const name = `cube_${spec.name}`;
  const children = spec.children ?? "none";

  if (spec.placement === "inline") {
    // Inline components are atoms in the editor; children would be lost.
    if (el.children.length > 0) return raw();
    return { kind: "node", node: { type: name, attrs: values }, inline: true };
  }

  if (children === "json") {
    const kids = el.children;
    if (kids.length === 0) {
      values.__children = null;
    } else if (kids.length === 1 && kids[0]!.type === "code" && kids[0].lang === "json" && !kids[0].meta) {
      values.__children = (kids[0] as Code).value;
    } else {
      return raw();
    }
    return { kind: "node", node: { type: name, attrs: values }, inline: false };
  }

  if (children === "markdown") {
    const content = nonEmpty(flowToBlocks(el.children as RootContent[], ctx));
    return { kind: "node", node: { type: name, attrs: values, content }, inline: false };
  }

  if (Array.isArray(children)) {
    const content: PMNodeJSON[] = [];
    for (const child of el.children) {
      if (child.type !== "mdxJsxFlowElement") return raw();
      if (!isComponentName(child.name) || !children.includes(child.name)) return raw();
      const sub = componentNodeJson(child, ctx);
      if (sub.kind !== "node" || sub.inline) return raw();
      content.push(sub.node);
    }
    return {
      kind: "node",
      node: { type: name, attrs: values, ...(content.length > 0 && { content }) },
      inline: false,
    };
  }

  // children === "none": self-closing only.
  if (el.children.length > 0) return raw();
  return { kind: "node", node: { type: name, attrs: values }, inline: false };
}

/* ---- inline (phrasing) content ------------------------------------------------------ */

function addMark(marks: PMMarkJSON[], mark: PMMarkJSON): PMMarkJSON[] {
  return [...marks, mark];
}

function withMarks(node: PMNodeJSON, marks: PMMarkJSON[]): PMNodeJSON {
  // hardBreak allows no marks in the ProseMirror schema.
  if (marks.length === 0 || node.type === "hardBreak") return node;
  return { ...node, marks };
}

function inlineToNodes(nodes: PhrasingContent[], ctx: Ctx, marks: PMMarkJSON[]): PMNodeJSON[] {
  const out: PMNodeJSON[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        if (node.value !== "") out.push(withMarks({ type: "text", text: node.value }, marks));
        break;
      case "strong":
        out.push(...inlineToNodes(node.children, ctx, addMark(marks, { type: "bold" })));
        break;
      case "emphasis":
        out.push(...inlineToNodes(node.children, ctx, addMark(marks, { type: "italic" })));
        break;
      case "delete":
        out.push(...inlineToNodes(node.children, ctx, addMark(marks, { type: "strike" })));
        break;
      case "inlineCode":
        out.push(withMarks({ type: "text", text: node.value }, addMark(marks, { type: "code" })));
        break;
      case "link":
        out.push(
          ...inlineToNodes(
            node.children,
            ctx,
            addMark(marks, { type: "link", attrs: { href: node.url, title: node.title ?? null } }),
          ),
        );
        break;
      case "image":
        out.push(
          withMarks(
            {
              type: "image",
              attrs: { src: node.url, alt: node.alt ?? null, title: node.title ?? null },
            },
            marks,
          ),
        );
        break;
      case "break":
        out.push({ type: "hardBreak" });
        break;
      case "wikiLink": {
        const wl = node as unknown as WikiLink;
        out.push(
          withMarks(
            { type: "wikiLink", attrs: { target: wl.target, label: wl.label ?? null } },
            marks,
          ),
        );
        break;
      }
      case "mdxJsxTextElement": {
        const converted = componentNodeJson(node, ctx);
        out.push(
          withMarks(
            converted.kind === "node" && converted.inline
              ? converted.node
              : {
                  type: "cubeUnknownInline",
                  attrs: { raw: converted.kind === "raw" ? converted.raw : rawOf(node, ctx) },
                },
            marks,
          ),
        );
        break;
      }
      case "html":
        out.push(withMarks({ type: "cubeUnknownInline", attrs: { raw: node.value } }, marks));
        break;
      default:
        // footnote references, link references, ...: preserve verbatim.
        out.push(withMarks(unknownInline(node, ctx), marks));
    }
  }
  return out;
}
