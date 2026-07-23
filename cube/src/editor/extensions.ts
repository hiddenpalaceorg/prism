/**
 * TipTap extension set generated from a cube component registry.
 *
 * The editor schema is a projection of cube's canonical markdown model:
 * StarterKit covers the plain-markdown constructs, a generated node per
 * registered component covers `<Component />` tags, and two safety-valve
 * nodes (cubeUnknown/cubeRawBlock) preserve everything the visual schema
 * cannot represent, byte-identical, via their `raw` attribute. Conversion
 * to/from this schema lives in from-mdast.ts / to-markdown.ts: TipTap's
 * own markdown machinery is deliberately not used.
 */

import { Node, type Extensions } from "@tiptap/core";
import { Code } from "@tiptap/extension-code";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import type { ComponentSpec, Registry } from "../schema/index";

/* ---- helpers -------------------------------------------------------------- */

/** Minimal DOM surface used by parse rules (cube's tsconfig carries no DOM lib). */
type DomElement = {
  getAttribute(name: string): string | null;
};

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Compact `key=value` summary shown inside component chips. */
function attrSummary(attrs: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || key === "__children") continue;
    parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  return truncate(parts.join(" "), 80);
}

/* ---- core wiki nodes ------------------------------------------------------- */

/** [[Target|label]] as an inline atom; label null means "display the target". */
export const WikiLinkNode = Node.create({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  marks: "_",
  addAttributes() {
    return { target: { default: "" }, label: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-cube-wikilink]",
        getAttrs: (el) => ({
          target: (el as unknown as DomElement).getAttribute("data-cube-wikilink") ?? "",
          label: (el as unknown as DomElement).getAttribute("data-label"),
        }),
      },
    ];
  },
  renderHTML({ node }) {
    const target = node.attrs.target as string;
    const label = node.attrs.label as string | null;
    return [
      "span",
      {
        "data-cube-wikilink": target,
        ...(label !== null && { "data-label": label }),
        class: "cube-ed-wikilink",
      },
      label !== null && label !== "" ? label : target,
    ];
  },
});

/** Minimal inline image node (StarterKit ships none); markdown `![alt](url)`. */
export const ImageNode = Node.create({
  name: "image",
  group: "inline",
  inline: true,
  atom: true,
  marks: "_",
  draggable: true,
  addAttributes() {
    return { src: { default: null }, alt: { default: null }, title: { default: null } };
  },
  parseHTML() {
    return [{ tag: "img[src]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", { ...HTMLAttributes, class: "cube-ed-image" }];
  },
});

/* ---- safety valves ---------------------------------------------------------- */

/** Unrecognized component tags (block position); serializes `raw` verbatim. */
export const CubeUnknown = Node.create({
  name: "cubeUnknown",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { raw: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-cube-unknown]",
        getAttrs: (el) => ({
          raw: (el as unknown as DomElement).getAttribute("data-cube-unknown") ?? "",
        }),
      },
    ];
  },
  renderHTML({ node }) {
    const raw = node.attrs.raw as string;
    return ["div", { "data-cube-unknown": raw, class: "cube-ed-unknown" }, truncate(raw, 160)];
  },
});

/** Inline variant of cubeUnknown (unknown inline tags, intrinsic tags, ...). */
export const CubeUnknownInline = Node.create({
  name: "cubeUnknownInline",
  group: "inline",
  inline: true,
  atom: true,
  marks: "_",
  addAttributes() {
    return { raw: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-cube-unknown]",
        getAttrs: (el) => ({
          raw: (el as unknown as DomElement).getAttribute("data-cube-unknown") ?? "",
        }),
      },
    ];
  },
  renderHTML({ node }) {
    const raw = node.attrs.raw as string;
    return ["span", { "data-cube-unknown": raw, class: "cube-ed-unknown cube-ed-inline" }, truncate(raw, 60)];
  },
});

/** Markdown constructs the visual schema cannot represent; serializes verbatim. */
export const CubeRawBlock = Node.create({
  name: "cubeRawBlock",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return { raw: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-cube-raw]",
        getAttrs: (el) => ({
          raw: (el as unknown as DomElement).getAttribute("data-cube-raw") ?? "",
        }),
      },
    ];
  },
  renderHTML({ node }) {
    const raw = node.attrs.raw as string;
    return ["div", { "data-cube-raw": raw, class: "cube-ed-raw" }, raw];
  },
});

/* ---- generated component nodes ---------------------------------------------- */

/**
 * One editor node per component spec. Attrs mirror the spec's attrs (default
 * null = "attribute absent"); children:"json" specs store their fenced JSON
 * child in a `__children` string attr instead of node content.
 */
export function componentNode(spec: ComponentSpec): Node {
  const inline = spec.placement === "inline";
  const children = spec.children ?? "none";
  // Array child policies restrict content to the listed component nodes so
  // the editor cannot produce documents the validator would reject.
  const content =
    !inline && children === "markdown"
      ? "block+"
      : !inline && Array.isArray(children)
        ? `(${children.map((n) => `cube_${n}`).join(" | ")})*`
        : undefined;
  const tag = inline ? "span" : "div";

  return Node.create({
    name: `cube_${spec.name}`,
    group: inline ? "inline" : "block",
    inline,
    atom: content === undefined,
    ...(content !== undefined && { content }),
    ...(inline && { marks: "_" }),
    draggable: !inline,
    addAttributes() {
      const attrs: Record<string, { default: null }> = {};
      for (const key of Object.keys(spec.attrs)) attrs[key] = { default: null };
      if (children === "json") attrs.__children = { default: null };
      return attrs;
    },
    parseHTML() {
      return [
        {
          tag: `${tag}[data-cube-component="${spec.name}"]`,
          getAttrs: (el) => {
            const raw = (el as unknown as DomElement).getAttribute("data-attrs");
            if (!raw) return {};
            try {
              return JSON.parse(raw) as Record<string, unknown>;
            } catch {
              return {};
            }
          },
        },
      ];
    },
    renderHTML({ node }) {
      // Neutral chip/box; NodeView previews rendering the real site View are
      // a follow-up. data-attrs keeps copy/paste inside the editor lossless.
      const meta = {
        "data-cube-component": spec.name,
        "data-attrs": JSON.stringify(node.attrs),
      };
      const summary = attrSummary(node.attrs as Record<string, unknown>);
      const label = `<${spec.name}>` + (summary === "" ? "" : ` ${summary}`);
      if (inline) {
        return ["span", { ...meta, class: "cube-ed-component cube-ed-inline" }, label];
      }
      if (content !== undefined) {
        return [
          "div",
          { ...meta, class: "cube-ed-component" },
          ["div", { class: "cube-ed-component-head", contenteditable: "false" }, label],
          ["div", { class: "cube-ed-component-body" }, 0],
        ];
      }
      return ["div", { ...meta, class: "cube-ed-component" }, label];
    },
  });
}

/**
 * TipTap's code mark excludes all other marks, but markdown happily nests
 * inline code inside bold/italic/links (`**a \`b\`**`). Lift the exclusion
 * so parsed documents stay schema-valid. (extension-code ships inside
 * starter-kit at the same version; only the schema exclusion changes.)
 */
const NestableCode = Code.extend({ excludes: "" });

/* ---- extension set ------------------------------------------------------------ */

export type BuildExtensionsOptions = {
  placeholder?: string;
};

export function buildExtensions(registry: Registry, options: BuildExtensionsOptions = {}): Extensions {
  return [
    StarterKit.configure({
      link: { openOnClick: false },
      // No mdast equivalent; keep the schema representable in markdown.
      underline: false,
      // Replaced by NestableCode below.
      code: false,
    }),
    NestableCode,
    // GFM column alignment survives as a table attr ProseMirror otherwise drops.
    Table.extend({
      addAttributes() {
        return { ...this.parent?.(), align: { default: null, rendered: false } };
      },
    }),
    TableRow,
    TableHeader,
    TableCell,
    Placeholder.configure({ placeholder: options.placeholder ?? "Start writing..." }),
    ImageNode,
    WikiLinkNode,
    CubeUnknown,
    CubeUnknownInline,
    CubeRawBlock,
    ...registry.all().map(componentNode),
  ];
}
