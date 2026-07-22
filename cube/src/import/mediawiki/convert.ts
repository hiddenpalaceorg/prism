/**
 * The conversion pipeline: Parsoid HTML -> cube markdown.
 *
 *   extractHtml       transclusions (data-mw, about-groups), extensions, categories
 *   apply mapping     template calls -> component/markdown/drop/verbatim placeholders
 *   hastToMarkdown    generic HTML -> markdown with wiki links + media images
 *   round-trip        re-parse through cube's own parser; failure = fallback
 *
 * Template ARGS come verbatim from data-mw (version-safe); expansions are only
 * used for keep-html templates (formatting long tail), which the mapping warns
 * about on historical revisions.
 */

import type { Element as HastElement, Nodes as HastNodes, Parent as HastParent } from "hast";
import { hasErrors } from "../../issues";
import { parseDocument } from "../../parse";
import { extractHtml, type ExtractedTransclusion } from "./extract-html";
import { parseAsk, parseShow } from "./ask";
import { parseFuzzyDate } from "./dates";
import { parseHexSnippets, type HexSnippetGroup } from "./hexdump";
import {
  componentPlaceholder,
  hastToMarkdown,
  markdownPlaceholder,
  verbatimPlaceholder,
} from "./to-markdown";
import type {
  AskQuery,
  ConversionResult,
  ConversionWarning,
  ConvertOptions,
  MapCtx,
  MappingResult,
  TemplateCall,
  WarningCode,
} from "./types";
import { parseCalls } from "./wikitext";

const WARNING_SEVERITY: Record<WarningCode, ConversionWarning["severity"]> = {
  UNMAPPED_TEMPLATE: "info",
  PARAM_UNKNOWN: "info",
  TEMPLATE_DELETED: "warning",
  TEMPLATE_EXPANDED_CURRENT: "info",
  LOST_TABLE_ATTRS: "warning",
  RAW_HTML_DROPPED: "warning",
  RAW_HTML_KEPT: "info",
  PARSE_FAILED_VERBATIM: "error",
  DATE_UNPARSEABLE: "warning",
  ASK_UNSUPPORTED: "warning",
  EXTENSION_UNSUPPORTED: "warning",
  VALIDATION_FAILED: "error",
};

export interface FullConvertOptions extends ConvertOptions {
  /** Handles {{#ask:}}/{{#show:}} calls (site-supplied, e.g. hpMapping's mapAsk). */
  mapAsk?: (ask: AskQuery, ctx: MapCtx) => MappingResult;
}

export function convert(html: string, opts: FullConvertOptions): ConversionResult {
  const warnings: ConversionWarning[] = [];
  const warn = (code: WarningCode, message: string, detail?: unknown) => {
    warnings.push({ code, message, severity: WARNING_SEVERITY[code], ...(detail !== undefined && { detail }) });
  };
  const ctx: MapCtx = {
    pageTitle: opts.pageTitle,
    warn,
    parseCalls,
    parseDate: parseFuzzyDate,
  };

  const extracted = extractHtml(html);

  // Decide replacements per transclusion group, then apply in one pass.
  const replacements = new Map<HastNodes, HastNodes[]>();
  const removals = new Set<HastNodes>();

  for (const t of extracted.transclusions) {
    const out = mapTransclusion(t, ctx, opts);
    if (out === "keep") continue;
    const [first, ...rest] = t.nodes;
    if (first) replacements.set(first, out);
    for (const n of rest) removals.add(n);
  }

  // Extension tags (gallery, youtube, ...).
  for (const ext of extracted.extensions) {
    const replacement = mapExtension(ext.kind, ext.node, ext.extsrc, ctx);
    if (replacement === "keep") continue;
    replacements.set(ext.node, replacement);
  }

  // Raw hex-snippet HTML (machine-generated ==Header== dumps) -> <HexDump>
  // with structured childrenJson. Unparseable snippets stay as text.
  const hexByParagraph = new Map<HastElement, { group: HexSnippetGroup; placeholder: HastElement }[]>();
  for (const group of parseHexSnippets(extracted.root)) {
    if (group.data === null) {
      warn("RAW_HTML_KEPT", "unparseable hex-snippet kept as plain text");
      continue;
    }
    const placeholder = componentPlaceholder("HexDump", {}, "block", group.data);
    if (group.parent.type === "element" && group.parent.tagName === "p") {
      let bucket = hexByParagraph.get(group.parent);
      if (!bucket) hexByParagraph.set(group.parent, (bucket = []));
      bucket.push({ group, placeholder });
    } else {
      const [first, ...rest] = group.nodes;
      if (first) replacements.set(first, [placeholder]);
      for (const n of rest) removals.add(n);
    }
  }
  // A block-level <HexDump> cannot live inside a paragraph: split the
  // paragraph around each dump (usually the paragraph holds only the dump).
  for (const [para, entries] of hexByParagraph) {
    replacements.set(para, splitParagraph(para, entries));
  }

  applyEdits(extracted.root, replacements, removals);

  if (opts.categories === "keep") {
    for (const cat of extracted.categories) {
      appendChild(extracted.root, componentPlaceholder("Category", { name: cat }, "block"));
    }
  }

  const { markdown: raw, lostTableAttrs } = hastToMarkdown(extracted.root);
  if (lostTableAttrs) {
    warn("LOST_TABLE_ATTRS", "table colspan/rowspan flattened by markdown conversion");
  }

  const markdown = tidy(raw);

  // Round-trip through cube's own parser: converter output must always parse.
  const check = parseDocument(markdown);
  if (!check.root || hasErrors(check.issues)) {
    warn("PARSE_FAILED_VERBATIM", "converted markdown does not re-parse; falling back to wikitext", {
      issues: check.issues,
    });
    return { markdown: null, ok: false, warnings, categories: extracted.categories };
  }

  return {
    markdown,
    ok: !warnings.some((w) => w.severity === "error"),
    warnings,
    categories: extracted.categories,
  };
}

/* ---- transclusions ---------------------------------------------------------- */

function mapTransclusion(
  t: ExtractedTransclusion,
  ctx: MapCtx,
  opts: FullConvertOptions,
): HastNodes[] | "keep" {
  const results: MappingResult[] = [];
  let keepHtml = false;

  for (const part of t.calls) {
    if (typeof part === "string") {
      if (part.trim() !== "") {
        ctx.warn(
          "RAW_HTML_DROPPED",
          "hand-written wikitext around a transclusion was dropped (components render their own layout)",
          { wikitext: part.slice(0, 200) },
        );
      }
      continue;
    }
    results.push(mapCall(part, ctx, opts));
  }

  if (results.length === 0) return [];
  if (results.some((r) => r.kind === "keep-html")) keepHtml = true;
  if (keepHtml) {
    if (results.length > 1) {
      // Mixed mappable + keep-html in one group can't be split; keep expansion.
      ctx.warn("RAW_HTML_KEPT", "transclusion group kept as expanded HTML (mixed mapping results)");
    }
    return "keep";
  }

  const nodes: HastNodes[] = [];
  for (const r of results) {
    switch (r.kind) {
      case "component":
        nodes.push(
          componentPlaceholder(r.name, r.attrs, r.placement ?? (t.inline ? "inline" : "block"), r.childrenJson),
        );
        break;
      case "markdown":
        nodes.push(markdownPlaceholder(r.markdown));
        break;
      case "verbatim": {
        const call = t.calls.find((c): c is TemplateCall => typeof c !== "string");
        nodes.push(verbatimPlaceholder(call ? serializeCall(call) : "(unrepresentable transclusion)"));
        break;
      }
      case "drop":
        break;
      case "keep-html":
        break; // handled above
    }
  }
  return nodes;
}

function mapCall(call: TemplateCall, ctx: MapCtx, opts: FullConvertOptions): MappingResult {
  if (call.kind === "function" && (call.name === "ask" || call.name === "show")) {
    if (!opts.mapAsk) {
      ctx.warn("ASK_UNSUPPORTED", `no #${call.name} mapping configured`);
      return { kind: "verbatim" };
    }
    // #show is #ask over one page with one printout, inline, limit 1.
    const ask: AskQuery =
      call.name === "ask"
        ? parseAsk(call)
        : (() => {
            const show = parseShow(call);
            return {
              conditions: `[[${show.page}]]`,
              printouts: show.printout ? [{ property: show.printout }] : [],
              format: "inline",
              limit: 1,
              sort: [],
              order: [],
              extra: {},
            };
          })();
    return opts.mapAsk(ask, ctx);
  }
  return opts.mapping.map(call, ctx);
}

export function serializeCall(call: TemplateCall): string {
  const params = Object.entries(call.params).map(([k, v]) => (/^\d+$/.test(k) ? v : `${k}=${v}`));
  const body = [call.kind === "function" ? `#${call.name}:${params[0] ?? ""}` : call.name,
    ...(call.kind === "function" ? params.slice(1) : params)].join("|");
  return `{{${body}}}`;
}

/* ---- extensions -------------------------------------------------------------- */

function mapExtension(
  kind: string,
  node: HastElement,
  extsrc: string | null,
  ctx: MapCtx,
): HastNodes[] | "keep" {
  if (kind === "gallery") {
    const dataMw = parseDataMw(node);
    const attrs = (dataMw?.attrs ?? {}) as Record<string, string>;
    const images = (extsrc ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .map((line) => {
        const [file, ...caption] = line.split("|");
        return {
          file: file!.replace(/^(File|Image):/i, "").trim(),
          ...(caption.length > 0 && { caption: caption.join("|").trim() }),
        };
      });
    return [
      componentPlaceholder(
        "Gallery",
        {
          ...(attrs.mode && { mode: normalizeGalleryMode(attrs.mode) }),
          ...(attrs.heights && { heights: Number.parseInt(attrs.heights, 10) }),
          ...(attrs.widths && { widths: Number.parseInt(attrs.widths, 10) }),
          images,
        },
        "block",
      ),
    ];
  }
  if (kind === "youtube") {
    const id = (extsrc ?? "").trim();
    if (id !== "") return [componentPlaceholder("YouTube", { id: extractYouTubeId(id) }, "block")];
    return [];
  }
  if (kind === "references" || kind === "ref") {
    ctx.warn("EXTENSION_UNSUPPORTED", `<${kind}> kept as expanded HTML (footnotes are a follow-up)`);
    return "keep";
  }
  ctx.warn("EXTENSION_UNSUPPORTED", `unsupported extension <${kind}> kept as expanded HTML`);
  return "keep";
}

function normalizeGalleryMode(mode: string): string {
  const m = mode.trim().toLowerCase();
  return m === "packed" || m === "nolines" ? m : "grid";
}

export function extractYouTubeId(value: string): string {
  const patterns = [/[?&]v=([A-Za-z0-9_-]{6,})/, /youtu\.be\/([A-Za-z0-9_-]{6,})/, /embed\/([A-Za-z0-9_-]{6,})/];
  for (const p of patterns) {
    const m = p.exec(value);
    if (m) return m[1]!;
  }
  return value;
}

function parseDataMw(node: HastElement): { attrs?: Record<string, string> } | null {
  const raw = (node.properties as Record<string, unknown>)?.dataMw;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as { attrs?: Record<string, string> };
  } catch {
    return null;
  }
}

/* ---- tree edits --------------------------------------------------------------- */

/** Replace a paragraph with (before-text p, HexDump placeholder, after-text p, ...),
 * dropping paragraph fragments that hold only whitespace. */
function splitParagraph(
  para: HastElement,
  entries: { group: HexSnippetGroup; placeholder: HastElement }[],
): HastNodes[] {
  const placeholderAt = new Map<HastNodes, HastElement>();
  const covered = new Set<HastNodes>();
  for (const e of entries) {
    const first = e.group.nodes[0];
    if (first) placeholderAt.set(first, e.placeholder);
    for (const n of e.group.nodes) covered.add(n);
  }
  const out: HastNodes[] = [];
  let run: HastNodes[] = [];
  const flush = () => {
    if (run.some((n) => n.type !== "text" || n.value.trim() !== "")) {
      out.push({ ...para, properties: {}, children: run } as HastElement);
    }
    run = [];
  };
  for (const child of para.children as HastNodes[]) {
    const placeholder = placeholderAt.get(child);
    if (placeholder) {
      flush();
      out.push(placeholder);
      continue;
    }
    if (covered.has(child)) continue;
    run.push(child);
  }
  flush();
  return out;
}

function applyEdits(
  root: HastNodes,
  replacements: Map<HastNodes, HastNodes[]>,
  removals: Set<HastNodes>,
): void {
  const visit = (node: HastNodes): void => {
    if (!("children" in node)) return;
    const parent = node as HastParent;
    let changed = false;
    const next: HastNodes[] = [];
    for (const child of parent.children as HastNodes[]) {
      if (removals.has(child)) {
        changed = true;
        continue;
      }
      const replacement = replacements.get(child);
      if (replacement) {
        next.push(...replacement);
        changed = true;
        continue;
      }
      next.push(child);
    }
    if (changed) parent.children = next as never;
    for (const child of parent.children as HastNodes[]) visit(child);
  };
  visit(root);
}

function appendChild(root: HastNodes, child: HastElement): void {
  // Append into <body> when present, else the root.
  let target: HastParent = root as HastParent;
  const findBody = (node: HastNodes): void => {
    if (node.type === "element" && node.tagName === "body") target = node;
    else if ("children" in node) (node.children as HastNodes[]).forEach(findBody);
  };
  findBody(root);
  target.children.push(child as never);
}

function tidy(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").trim() + "\n";
}
