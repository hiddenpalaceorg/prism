/**
 * Parsoid-HTML transclusion extraction (stage 1 of the MediaWiki converter).
 *
 * Input is inline-data-mw Parsoid HTML from core REST v1 with_html (see
 * spikes/parsoid-probe.md). Selection is by `typeof` token match, never by
 * data-mw presence (mw:File captions carry data-mw too). One transclusion may
 * span several sibling nodes sharing an about="#mwtN" id; only the first node
 * carries data-mw. Parsoid sometimes double-annotates one template call
 * (section wrapper + inner node, identical parts, different about ids): the
 * outermost annotation wins.
 */

import type { Element as HastElement, Root as HastRoot } from "hast";
import { fromHtml } from "hast-util-from-html";
import type { TemplateCall } from "./types";

export type ExtractedTransclusion = {
  aboutId: string | null;
  /** data-mw.parts in order: template objects converted to TemplateCall,
   * literal wikitext string parts (hand-written surrounding markup) kept. */
  calls: Array<string | TemplateCall>;
  /** All top-level nodes of the about-group, in document order (the first
   * carries data-mw). References into `root`: mutating them mutates it. */
  nodes: HastElement[];
  /** True when the first node is phrasing-level (span/a/small ...). */
  inline: boolean;
};

export type ExtractedExtension = {
  /** Extension tag name from typeof mw:Extension/<kind>. */
  kind: string;
  node: HastElement;
  /** Verbatim inner source (data-mw body.extsrc), null when absent. */
  extsrc: string | null;
};

export type ExtractHtmlResult = {
  /** Parsed tree; transclusion/extension node refs point into it. */
  root: HastRoot;
  /** One entry per about-group, duplicate annotations removed. */
  transclusions: ExtractedTransclusion[];
  extensions: ExtractedExtension[];
  /** Plain category titles ("./Category:Foo_bar" -> "Foo bar"). */
  categories: string[];
};

/* -------------------------------------------------------------------------
 * data-mw JSON shapes (only the fields the extractor reads).
 * ---------------------------------------------------------------------- */

type DataMwTarget = {
  wt?: string;
  href?: string;
  function?: string;
};

type DataMwTemplate = {
  target?: DataMwTarget;
  params?: Record<string, { wt?: string }>;
  i?: number;
};

type DataMwPart = string | { template?: DataMwTemplate };

type DataMw = {
  parts?: DataMwPart[];
  name?: string;
  body?: { extsrc?: string };
};

/** Tags treated as phrasing-level for `inline` detection. */
const PHRASING_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "big", "br", "cite", "code", "data", "del",
  "dfn", "em", "font", "i", "img", "ins", "kbd", "mark", "q", "ruby", "s",
  "samp", "small", "span", "strong", "sub", "sup", "time", "tt", "u", "var",
  "wbr",
]);

function typeofTokens(node: HastElement): string[] {
  const value = node.properties?.typeof;
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}

function aboutId(node: HastElement): string | null {
  const value = node.properties?.about;
  return typeof value === "string" && value !== "" ? value : null;
}

function parseDataMw(node: HastElement): DataMw | null {
  const raw = node.properties?.dataMw;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as DataMw)
      : null;
  } catch {
    return null;
  }
}

/** "./Category:Foo_bar" -> "Foo bar" (strip prefix, %-decode, _ -> space). */
function decodeCategoryHref(href: string): string {
  let title = href.replace(/^\.\//, "");
  try {
    title = decodeURIComponent(title);
  } catch {
    // keep raw on malformed escapes
  }
  return title.replace(/^Category:/, "").replace(/_/g, " ");
}

/**
 * Convert one data-mw template object to a TemplateCall.
 *
 * Parser functions (target.function set, no href): the first positional
 * argument rides inside target.wt after "#name:": split it out into param
 * "1". Parsoid keys any further bare arguments starting at "1" as well, so
 * existing numeric keys shift up by one (they are arguments 2..n in source).
 * Named params (incl. SMW "?printout" selectors) keep their keys.
 */
function toTemplateCall(tpl: DataMwTemplate): TemplateCall {
  const target = tpl.target ?? {};
  const rawParams = tpl.params ?? {};

  if (typeof target.function === "string" && target.function !== "") {
    const params: Record<string, string> = {};
    const wt = typeof target.wt === "string" ? target.wt : "";
    const colon = wt.indexOf(":");
    const shift = colon >= 0;
    if (shift) params["1"] = wt.slice(colon + 1);
    for (const [key, value] of Object.entries(rawParams)) {
      const outKey =
        shift && /^\d+$/.test(key) ? String(Number(key) + 1) : key;
      params[outKey] = value?.wt ?? "";
    }
    return { kind: "function", name: target.function, params };
  }

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawParams)) {
    params[key] = value?.wt ?? "";
  }
  return {
    kind: "template",
    name: (target.wt ?? "").trim(),
    params,
  };
}

function partsToCalls(parts: DataMwPart[]): Array<string | TemplateCall> {
  const calls: Array<string | TemplateCall> = [];
  for (const part of parts) {
    if (typeof part === "string") {
      calls.push(part);
    } else if (part !== null && typeof part === "object" && part.template) {
      calls.push(toTemplateCall(part.template));
    }
    // other part shapes (none observed in article space) are dropped
  }
  return calls;
}

/** A typeof=mw:Transclusion node carrying parsed parts, pre-dedupe. */
type MarkedRoot = {
  node: HastElement;
  about: string | null;
  parts: DataMwPart[];
  /** JSON.stringify(parts): duplicate-annotation comparison key. */
  partsKey: string;
  /** Element ancestor chain at visit time (document order, outermost first). */
  ancestors: HastElement[];
};

export function extractHtml(html: string): ExtractHtmlResult {
  const root = fromHtml(html);

  const marked: MarkedRoot[] = [];
  const extensions: ExtractedExtension[] = [];
  const categories: string[] = [];
  /** Top-level nodes per about id (nodes whose ancestors lack the same id). */
  const groupNodes = new Map<string, HastElement[]>();

  const elemStack: HastElement[] = [];
  const aboutStack: string[] = [];

  const visit = (node: HastRoot | HastRoot["children"][number]): void => {
    if (node.type !== "element" && node.type !== "root") {
      return;
    }
    let pushedAbout = false;
    if (node.type === "element") {
      const about = aboutId(node);
      if (about !== null && !aboutStack.includes(about)) {
        let group = groupNodes.get(about);
        if (!group) groupNodes.set(about, (group = []));
        group.push(node);
      }

      const tokens = typeofTokens(node);
      const extToken = tokens.find((t) => t.startsWith("mw:Extension/"));
      if (extToken) {
        // Extension nodes are never also reported as transclusions.
        const mw = parseDataMw(node);
        extensions.push({
          kind: extToken.slice("mw:Extension/".length),
          node,
          extsrc: mw?.body?.extsrc ?? null,
        });
      } else if (tokens.includes("mw:Transclusion")) {
        const mw = parseDataMw(node);
        if (mw && Array.isArray(mw.parts)) {
          marked.push({
            node,
            about,
            parts: mw.parts,
            partsKey: JSON.stringify(mw.parts),
            ancestors: [...elemStack],
          });
        }
      }

      if (node.tagName === "link") {
        // hast types rel as a (space-separated) string array.
        const rel = node.properties?.rel;
        const rels = Array.isArray(rel) ? rel.map(String) : [];
        const href = node.properties?.href;
        if (rels.includes("mw:PageProp/Category") && typeof href === "string") {
          categories.push(decodeCategoryHref(href));
        }
      }

      elemStack.push(node);
      if (about !== null) {
        aboutStack.push(about);
        pushedAbout = true;
      }
    }

    for (const child of node.children) visit(child);

    if (node.type === "element") {
      elemStack.pop();
      if (pushedAbout) aboutStack.pop();
    }
  };
  visit(root);

  // Duplicate-annotation dedupe (probe gotcha 2): a marked node whose parts
  // serialize identically to an earlier marked node with a DIFFERENT about
  // id, and which sits inside that earlier group's expansion, is the same
  // template call re-annotated across Parsoid section wrappers. Keep the
  // outermost (document-order first). Nested transclusions with different
  // parts stay separate entries.
  const keptByPartsKey = new Map<string, MarkedRoot[]>();
  const kept: MarkedRoot[] = [];
  for (const entry of marked) {
    const rivals = keptByPartsKey.get(entry.partsKey);
    const duplicateOf = rivals?.find((outer) => {
      if (outer.about === entry.about) return false;
      const outerNodes =
        outer.about !== null
          ? (groupNodes.get(outer.about) ?? [outer.node])
          : [outer.node];
      return outerNodes.some((n) => entry.ancestors.includes(n));
    });
    if (duplicateOf) continue;
    kept.push(entry);
    let bucket = keptByPartsKey.get(entry.partsKey);
    if (!bucket) keptByPartsKey.set(entry.partsKey, (bucket = []));
    bucket.push(entry);
  }

  const transclusions: ExtractedTransclusion[] = kept.map((entry) => {
    const group =
      entry.about !== null ? groupNodes.get(entry.about) : undefined;
    const nodes = group && group.length > 0 ? group : [entry.node];
    const first = nodes[0] ?? entry.node;
    return {
      aboutId: entry.about,
      calls: partsToCalls(entry.parts),
      nodes,
      inline: PHRASING_TAGS.has(first.tagName),
    };
  });

  return { root, transclusions, extensions, categories };
}
