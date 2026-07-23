/**
 * The reading render path: cube AST -> React elements.
 *
 * Sanitization is structural, never filter-based: markdown `html` nodes render
 * as escaped text, only allowlisted lowercase tags become elements, and
 * component tags render only through the host-supplied binding map. Async
 * component wrappers make this RSC-compatible (loaders fetch server-side).
 */

import GithubSlugger from "github-slugger";
import { Fragment, createElement as h, type ReactNode } from "react";
import type {
  Code,
  Heading,
  Image as MdImage,
  Link as MdLink,
  List,
  Node,
  Parent,
  Root,
  Table,
} from "mdast";
import type { JsxElement } from "../mdx";
import { isComponentName, isJsxElement, rawAttrs } from "../mdx";
import type { WikiLink } from "../parse";
import type { ObjectQuery, QueryResult, QueryRow } from "../query";
import { toObjectQuery } from "../query-component";
import type { PageRef, Registry } from "../schema/index";
import { normalizeAttrs } from "../schema/index";
import { DEFAULT_SLUG_CONFIG, isTitleError, normalizeTitle, type SlugConfig } from "../slug";
import { DEFAULT_INTRINSIC_TAGS } from "../validate";

export type ComponentViewProps = {
  attrs: Record<string, unknown>;
  data?: unknown;
  children?: ReactNode;
  /** Parsed fenced-JSON child, for components declared children: "json". */
  childrenJson?: unknown;
  readOnly?: boolean;
  page: PageRef;
};

export type ComponentBinding = {
  /** Server-only data fetch; its result is passed to View as `data`. */
  loader?: (attrs: Record<string, unknown>, ctx: CubeRenderCtx) => Promise<unknown>;
  /** Client-safe presentational component (also used by the editor preview). */
  View: (props: ComponentViewProps) => ReactNode | Promise<ReactNode>;
};

export type LinkInfo = {
  href: string;
  exists: boolean;
};

export type ResultRenderer = (rows: QueryRow[], attrs: Record<string, unknown>, ctx: CubeRenderCtx) => ReactNode;

export type CubeRenderCtx = {
  registry: Registry;
  page: PageRef;
  /** URL for a page ref: the host owns the URL scheme. */
  pageHref: (ref: { ns: string; slug: string }) => string;
  bindings?: Record<string, ComponentBinding>;
  resultRenderers?: Record<string, ResultRenderer>;
  /** Batch page-existence check for red links; default marks all existing. */
  resolveLinks?: (refs: { ns: string; slug: string }[]) => Promise<Map<string, boolean>>;
  /** Media name -> public URL; default null (renders a missing-media span). */
  resolveMedia?: (names: string[]) => Promise<Map<string, string | null>>;
  /** Executes <Query> instances; absent = queries render a placeholder. */
  runQuery?: (q: ObjectQuery) => Promise<QueryResult>;
  slug?: SlugConfig;
  intrinsicTags?: readonly string[];
  interwiki?: Record<string, string>;
};

export type RenderedPage = {
  node: ReactNode;
  headings: { depth: number; text: string; id: string }[];
};

export async function renderAst(root: Root, ctx: CubeRenderCtx): Promise<RenderedPage> {
  const slugCfg = ctx.slug ?? DEFAULT_SLUG_CONFIG;

  // Pass 1: collect wiki-link targets and media names for batch resolution.
  const linkRefs = new Map<string, { ns: string; slug: string }>();
  const mediaNames = new Set<string>();
  collect(root, (node) => {
    if (node.type === "wikiLink") {
      const ref = resolveTarget((node as unknown as WikiLink).target, slugCfg, ctx.interwiki);
      if (ref.kind === "page") linkRefs.set(`${ref.ns}:${ref.slug}`, ref);
    }
    if (node.type === "image") {
      const url = (node as MdImage).url;
      if (url.startsWith("media:")) mediaNames.add(url.slice("media:".length));
    }
  });

  const linkMap = ctx.resolveLinks
    ? await ctx.resolveLinks([...linkRefs.values()])
    : new Map<string, boolean>();
  const mediaMap = ctx.resolveMedia
    ? await ctx.resolveMedia([...mediaNames])
    : new Map<string, string | null>();

  const slugger = new GithubSlugger();
  const headings: RenderedPage["headings"] = [];
  const state: RenderState = { ctx, slugCfg, linkMap, mediaMap, slugger, headings, key: 0 };
  const node = renderChildren(root as unknown as Parent, state);
  return { node, headings };
}

type RenderState = {
  ctx: CubeRenderCtx;
  slugCfg: SlugConfig;
  linkMap: Map<string, boolean>;
  mediaMap: Map<string, string | null>;
  slugger: GithubSlugger;
  headings: RenderedPage["headings"];
  key: number;
};

function collect(node: Node, fn: (n: Node) => void): void {
  fn(node);
  if ("children" in node && Array.isArray((node as Parent).children)) {
    for (const c of (node as Parent).children) collect(c as Node, fn);
  }
}

function renderChildren(parent: Parent, state: RenderState): ReactNode {
  return h(
    Fragment,
    null,
    ...parent.children.map((c) => renderNode(c as Node, state)),
  );
}

function textOf(node: Node): string {
  if (node.type === "text" || node.type === "inlineCode") return (node as unknown as { value: string }).value;
  if ("children" in node) return (node as Parent).children.map((c) => textOf(c as Node)).join("");
  return "";
}

function renderNode(node: Node, state: RenderState): ReactNode {
  const key = `k${state.key++}`;
  const { ctx } = state;

  switch (node.type) {
    case "text":
      return (node as unknown as { value: string }).value;
    case "paragraph":
      return h("p", { key }, renderChildren(node as Parent, state));
    case "heading": {
      const depth = (node as Heading).depth;
      const text = textOf(node);
      const id = state.slugger.slug(text);
      state.headings.push({ depth, text, id });
      return h(`h${depth}`, { key, id }, renderChildren(node as Parent, state));
    }
    case "emphasis":
      return h("em", { key }, renderChildren(node as Parent, state));
    case "strong":
      return h("strong", { key }, renderChildren(node as Parent, state));
    case "delete":
      return h("del", { key }, renderChildren(node as Parent, state));
    case "inlineCode":
      return h("code", { key }, (node as unknown as { value: string }).value);
    case "code": {
      const c = node as Code;
      return h("pre", { key, className: c.lang ? `cube-code language-${c.lang}` : "cube-code" },
        h("code", null, c.value));
    }
    case "blockquote":
      return h("blockquote", { key }, renderChildren(node as Parent, state));
    case "list": {
      const l = node as List;
      return h(l.ordered ? "ol" : "ul", { key, ...(l.start != null && l.start !== 1 && { start: l.start }) },
        renderChildren(node as Parent, state));
    }
    case "listItem": {
      const li = node as Parent & { checked?: boolean | null };
      const checkbox =
        li.checked == null
          ? null
          : h("input", { type: "checkbox", checked: li.checked, readOnly: true, disabled: true });
      return h("li", { key }, checkbox, renderChildren(li, state));
    }
    case "thematicBreak":
      return h("hr", { key });
    case "break":
      return h("br", { key });
    case "link": {
      const l = node as MdLink;
      const external = /^(https?:|mailto:)/.test(l.url);
      if (!external) {
        // Non-http URLs in plain markdown links render as text (structural sanitization).
        return h("span", { key }, renderChildren(l, state));
      }
      return h("a", { key, href: l.url, rel: "nofollow noopener", className: "cube-external" },
        renderChildren(l, state));
    }
    case "image": {
      const img = node as MdImage;
      if (img.url.startsWith("media:")) {
        const name = img.url.slice("media:".length);
        const src = state.mediaMap.get(name);
        if (!src) {
          return h("span", { key, className: "cube-missing-media" }, `[missing media: ${name}]`);
        }
        return h("img", { key, src, alt: img.alt ?? "" });
      }
      if (/^https?:/.test(img.url)) return h("img", { key, src: img.url, alt: img.alt ?? "" });
      return h("span", { key, className: "cube-missing-media" }, img.alt ?? img.url);
    }
    case "table": {
      const t = node as Table;
      const [head, ...body] = t.children;
      const cellTag = (isHead: boolean) => (isHead ? "th" : "td");
      const renderRow = (row: Parent, isHead: boolean, rk: string) =>
        h("tr", { key: rk },
          ...row.children.map((cell, i) =>
            h(cellTag(isHead), {
              key: `c${i}`,
              ...(t.align?.[i] && { style: { textAlign: t.align[i]! } }),
            }, renderChildren(cell as Parent, state))));
      return h("table", { key, className: "cube-table" },
        head ? h("thead", null, renderRow(head as Parent, true, "h")) : null,
        h("tbody", null, ...body.map((r, i) => renderRow(r as Parent, false, `r${i}`))));
    }
    case "html":
      // Structural sanitization: raw HTML renders as escaped literal text.
      return h("span", { key, className: "cube-raw" }, (node as unknown as { value: string }).value);
    case "wikiLink":
      return renderWikiLink(node as unknown as WikiLink, state, key);
    case "mdxJsxFlowElement":
    case "mdxJsxTextElement":
      return renderJsx(node as JsxElement, state, key);
    default:
      if ("children" in node) return renderChildren(node as Parent, state);
      return null;
  }
}

function resolveTarget(
  target: string,
  slugCfg: SlugConfig,
  interwiki?: Record<string, string>,
):
  | { kind: "page"; ns: string; slug: string; title: string; fragment?: string }
  | { kind: "interwiki"; href: string; label: string }
  | { kind: "invalid"; label: string } {
  const colon = target.indexOf(":");
  if (colon > 0 && interwiki) {
    const prefix = target.slice(0, colon).toLowerCase();
    const tpl = interwiki[prefix];
    if (tpl) {
      const rest = target.slice(colon + 1).trim();
      return { kind: "interwiki", href: tpl.replace("$1", encodeURI(rest.replace(/ /g, "_"))), label: rest };
    }
  }
  const ref = normalizeTitle(target, slugCfg);
  if (isTitleError(ref)) return { kind: "invalid", label: target };
  return { kind: "page", ns: ref.ns, slug: ref.slug, title: ref.title, ...(ref.fragment && { fragment: ref.fragment }) };
}

function renderWikiLink(link: WikiLink, state: RenderState, key: string): ReactNode {
  const resolved = resolveTarget(link.target, state.slugCfg, state.ctx.interwiki);
  if (resolved.kind === "invalid") {
    return h("span", { key, className: "cube-invalid-link" }, link.label || link.target);
  }
  if (resolved.kind === "interwiki") {
    return h("a", { key, href: resolved.href, className: "cube-interwiki" }, link.label || resolved.label);
  }
  const exists = state.linkMap.get(`${resolved.ns}:${resolved.slug}`) ?? true;
  const href =
    state.ctx.pageHref({ ns: resolved.ns, slug: resolved.slug }) +
    (resolved.fragment ? `#${resolved.fragment}` : "");
  const label = link.label !== undefined && link.label !== "" ? link.label : resolved.title;
  return h("a", { key, href, className: exists ? "cube-link" : "cube-redlink" }, label);
}

function renderJsx(el: JsxElement, state: RenderState, key: string): ReactNode {
  const { ctx } = state;
  const name = el.name ?? "";

  if (!isComponentName(name)) {
    const allowed = new Set(ctx.intrinsicTags ?? DEFAULT_INTRINSIC_TAGS);
    if (!allowed.has(name)) {
      return h("span", { key, className: "cube-raw" }, `<${name}>`);
    }
    const props: Record<string, unknown> = { key };
    for (const a of el.attributes) {
      if (a.type === "mdxJsxAttribute" && typeof a.value === "string") {
        if (a.name === "class") props.className = a.value;
        else if (a.name === "title" || a.name === "id") props[a.name] = a.value;
      }
    }
    return h(name, props, el.children.length > 0 ? renderChildren(el, state) : undefined);
  }

  const spec = ctx.registry.get(name);
  const { attrs: raw } = rawAttrs(el);
  const attrs = spec ? normalizeAttrs(spec, raw, { page: ctx.page }).values : raw;

  // Metadata built-ins render nothing.
  if (name === "Redirect" || name === "Category" || name === "DisplayTitle") return null;

  const binding = ctx.bindings?.[name];

  // children:"json" components get the parsed payload, not rendered children.
  let childrenJson: unknown;
  let children: ReactNode | undefined;
  if (spec?.children === "json") {
    const code = el.children.find((c) => c.type === "code") as { value?: string } | undefined;
    if (code?.value !== undefined) {
      try {
        childrenJson = JSON.parse(code.value);
      } catch {
        childrenJson = undefined;
      }
    }
  } else {
    children = el.children.length > 0 ? renderChildren(el, state) : undefined;
  }

  if (binding) {
    if (binding.loader) {
      const loader = binding.loader;
      const View = binding.View;
      const Bound = async () => {
        const data = await loader(attrs, ctx);
        return View({ attrs, data, children, childrenJson, page: ctx.page });
      };
      return h(Bound as never, { key });
    }
    return h(binding.View as never, { key, attrs, children, childrenJson, page: ctx.page });
  }

  // Default views for built-ins without a host binding.
  switch (name) {
    case "Query":
      return h(makeQueryView(attrs, state) as never, { key });
    case "Anchor":
      return h("span", { key, id: String(attrs.id ?? "") });
    case "TOC":
      return h(TocView as never, { key, headings: state.headings });
    case "YouTube":
      return h("iframe", {
        key,
        className: "cube-youtube",
        src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(String(attrs.id ?? ""))}`,
        allowFullScreen: true,
        loading: "lazy",
        title: String(attrs.title ?? "YouTube video"),
      });
    case "Image":
      return h(makeImageView(attrs, state) as never, { key });
    case "Gallery":
      return h(makeGalleryView(attrs, state) as never, { key });
    case "Include":
      // Requires a host binding (needs page fetch + recursion guard).
      return h("span", { key, className: "cube-missing-binding" }, `[Include: ${String(attrs.page ?? "")}]`);
    default:
      return h("span", { key, className: "cube-missing-binding" }, `[${name}]`);
  }
}

/* ---- default built-in views ---------------------------------------------- */

function makeQueryView(attrs: Record<string, unknown>, state: RenderState) {
  const { ctx } = state;
  return async function QueryView(): Promise<ReactNode> {
    if (!ctx.runQuery) {
      return h("div", { className: "cube-query-placeholder" }, "[query]");
    }
    const format = String(attrs.format ?? "table");
    const result = await ctx.runQuery(toObjectQuery(attrs, { ns: ctx.page.ns, slug: ctx.page.slug }));

    if (result.kind === "agg") {
      const first = result.rows[0] ?? {};
      const value = (first as Record<string, unknown>)[format === "count" ? "count" : "value"];
      return h("span", { className: "cube-query-value" }, String(value ?? ""));
    }

    const rows = result.rows;
    if (format === "render") {
      const renderer = ctx.resultRenderers?.[String(attrs.render ?? "")];
      if (!renderer) {
        return h("div", { className: "cube-query-error" }, `[unknown result renderer: ${String(attrs.render)}]`);
      }
      return renderer(rows, attrs, ctx);
    }
    if (format === "ul") {
      return h(
        "ul",
        { className: "cube-query-list" },
        ...rows.map((r, i) =>
          h("li", { key: i }, h("a", { href: ctx.pageHref(r.page) }, r.page.displayTitle ?? r.page.title)),
        ),
      );
    }
    if (format === "inline") {
      const fields = (attrs.select as string[] | undefined) ?? [];
      const texts = rows.map((r) => fields.map((f) => String(r.data[f] ?? "")).join(", "));
      return h("span", { className: "cube-query-inline" }, texts.join("; "));
    }

    // table (default)
    const select = (attrs.select as string[] | undefined) ?? [];
    const headers = (attrs.headers as string[] | undefined) ?? select;
    return h(
      "table",
      { className: "cube-table cube-query-table" },
      h("thead", null, h("tr", null, h("th", null, ""), ...headers.map((hd, i) => h("th", { key: i }, hd)))),
      h(
        "tbody",
        null,
        ...rows.map((r, i) =>
          h(
            "tr",
            { key: i },
            h("td", null, h("a", { href: ctx.pageHref(r.page) }, r.page.displayTitle ?? r.page.title)),
            ...select.map((f, j) => h("td", { key: j }, formatCell(r.data[f]))),
          ),
        ),
      ),
      result.truncated
        ? h("caption", { className: "cube-query-truncated" }, "results truncated")
        : null,
    );
  };
}

function formatCell(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(String).join(", ");
  return String(v);
}

function TocView({ headings }: { headings: RenderedPage["headings"] }): ReactNode {
  // Note: TOC placed mid-document sees headings rendered before it; hosts
  // wanting a complete TOC should use renderAst().headings in their layout.
  return h(
    "nav",
    { className: "cube-toc" },
    h("ul", null, ...headings.map((hd, i) =>
      h("li", { key: i, className: `cube-toc-d${hd.depth}` }, h("a", { href: `#${hd.id}` }, hd.text)),
    )),
  );
}

function makeImageView(attrs: Record<string, unknown>, state: RenderState) {
  const { ctx } = state;
  return async function ImageView(): Promise<ReactNode> {
    const name = String(attrs.file ?? "");
    const map = ctx.resolveMedia ? await ctx.resolveMedia([name]) : new Map<string, string | null>();
    const src = map.get(name);
    if (!src) return h("span", { className: "cube-missing-media" }, `[missing media: ${name}]`);
    const img = h("img", {
      src,
      alt: String(attrs.caption ?? name),
      ...(typeof attrs.width === "number" && { width: attrs.width }),
      ...(typeof attrs.height === "number" && { height: attrs.height }),
    });
    if (attrs.caption) {
      return h("figure", { className: "cube-figure" }, img, h("figcaption", null, String(attrs.caption)));
    }
    return img;
  };
}

function makeGalleryView(attrs: Record<string, unknown>, state: RenderState) {
  const { ctx } = state;
  return async function GalleryView(): Promise<ReactNode> {
    const images = (attrs.images as { file: string; caption?: string }[] | undefined) ?? [];
    const names = images.map((i) => i.file);
    const map = ctx.resolveMedia ? await ctx.resolveMedia(names) : new Map<string, string | null>();
    return h(
      "div",
      { className: `cube-gallery cube-gallery-${String(attrs.mode ?? "grid")}` },
      ...images.map((img, i) => {
        const src = map.get(img.file);
        return h(
          "figure",
          { key: i, className: "cube-gallery-item" },
          src
            ? h("img", { src, alt: img.caption ?? img.file, ...(typeof attrs.heights === "number" && { height: attrs.heights }) })
            : h("span", { className: "cube-missing-media" }, `[missing media: ${img.file}]`),
          img.caption ? h("figcaption", null, img.caption) : null,
        );
      }),
    );
  };
}
