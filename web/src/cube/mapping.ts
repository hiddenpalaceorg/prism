/**
 * Hidden Palace template -> component mapping for the MediaWiki converter
 *. Pure translation logic: template call arguments in,
 * MappingResult out. Uses only ctx.parseCalls / ctx.parseDate / ctx.warn so
 * it is testable without the pipeline.
 *
 * #ask handling lives in `mapAsk`, which the pipeline calls with a preparsed
 * AskQuery for function calls named "ask"/"show" (the #ask grammar itself is
 * parallel work in cube/src/import/mediawiki/ask.ts and not imported here).
 */

import { serializeComponentTag } from "cube";
import type {
  AskQuery,
  MapCtx,
  MappingResult,
  TemplateCall,
  TemplateMapping,
} from "../../../cube/src/import/mediawiki/types";
import { FileEntry, FileList } from "./schemas";

// ---------------------------------------------------------------------------
// Param rule tables

type ParamKind =
  | "string"
  | "date" // ctx.parseDate; unparseable -> DATE_UNPARSEABLE + drop (attr is date-typed)
  | "csv" // comma-separated -> string[]
  | "ssv" // semicolon-separated -> string[]
  | "number"
  | "boolean";

type ParamRule = {
  attr: string;
  kind: ParamKind;
};

/** Build a lookup of lowercased param aliases ("a|b|c") to one rule. */
function rules(entries: [aliases: string, attr: string, kind?: ParamKind][]): Map<string, ParamRule> {
  const m = new Map<string, ParamRule>();
  for (const [aliases, attr, kind] of entries) {
    for (const name of aliases.split("|")) m.set(name, { attr, kind: kind ?? "string" });
  }
  return m;
}

const PROTOTYPE_RULES = rules([
  ["titlescreen", "titleScreen"],
  ["builddate|date", "buildDate", "date"],
  ["buildname|build name|build_name", "buildName"],
  ["status", "status"],
  ["datstatus", "datStatus"],
  ["dumper|dumpedby", "dumpedBy", "csv"],
  ["releasedby", "releasedBy", "csv"],
  ["filedumpdate", "fileDumpDate", "date"],
  ["filereleasedate", "fileReleaseDate", "date"],
  ["origin_type", "originType"],
  ["origin_lot", "originLot"],
  ["origin_eproms", "originEproms"],
  ["origin_board", "originBoard"],
  ["origin_disc_type", "originDiscType"],
  ["origin_dev_kit", "originDevKit"],
  ["origin_labels|origin_label", "originLabels"],
  ["origin_files|origin_file", "originFiles"],
  ["origin_dumpmethod", "originDumpMethod"],
  ["origin_ownership", "originOwnership"],
  ["game", "game"],
  ["system", "system"],
  ["genre", "genre"],
  ["final_builddate", "finalBuildDate"],
  ["unreleased", "unreleased", "boolean"],
  ["sortnumber", "sortNumber", "number"],
  ["builtafter", "builtAfter", "date"],
  ["news_page", "newsPage"],
]);

const BOARD_RULES = rules([
  ["hardware_id", "hardwareId"],
  ["hardware_type", "hardwareType"],
  ["hardware_date", "hardwareDate", "date"],
  ["chips", "chips", "csv"],
  ["text", "text"],
  ["photo", "photo"],
  ["system", "system"],
  ["game", "game"],
]);

const VIDEO_RULES = rules([
  ["video_date|date", "videoDate", "date"],
  ["video_status|status", "videoStatus"],
  ["video_media", "videoMedia"],
  ["transferredby", "transferredBy", "csv"],
  ["game", "game", "ssv"],
  ["system", "system"],
  ["genre", "genre"],
]);

const FILELISTENTRY_RULES = rules([
  ["1", "n", "number"],
  ["filename", "filename"],
  ["game", "game"],
  ["type", "type"],
  ["date", "date"],
  ["size", "size", "number"],
  ["comment", "comment"],
  ["indent", "indent", "number"],
  ["crc32", "crc32"],
  ["md5", "md5"],
  ["sha1", "sha1"],
  ["sha256", "sha256"],
]);

/** Pure machinery templates resolved (or meaningless) at convert time. */
const TEMPLATE_DROPS = new Set(["system", "imageexists", "filesize", "donotuploadlist", "autolink user"]);

/** Parser functions that are template plumbing with no content of their own. */
const FUNCTION_DROPS = new Set([
  "default_form",
  "arraydefine",
  "arrayprint",
  "regex",
  "if",
  "ifexpr",
  "ifexist",
  "time",
  "tag",
]);

// ---------------------------------------------------------------------------
// Shared helpers

/** The empty-param template bug from recon: literal {{{param}}} passthroughs. */
function isPassthrough(value: string): boolean {
  return /^\{\{\{[^{}]*\}\}\}$/.test(value);
}

function splitList(value: string, sep: string): string[] {
  return value
    .split(sep)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function applyRule(
  rule: ParamRule,
  value: string,
  attrs: Record<string, unknown>,
  ctx: MapCtx,
  template: string,
  param: string,
): void {
  switch (rule.kind) {
    case "string":
      attrs[rule.attr] = value;
      return;
    case "date": {
      const iso = ctx.parseDate(value);
      if (iso === null) {
        ctx.warn("DATE_UNPARSEABLE", `${template}: ${param}="${value}" is not a parseable date; dropped`);
        return;
      }
      attrs[rule.attr] = iso;
      return;
    }
    case "csv":
      attrs[rule.attr] = splitList(value, ",");
      return;
    case "ssv":
      attrs[rule.attr] = splitList(value, ";");
      return;
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        ctx.warn("VALIDATION_FAILED", `${template}: ${param}="${value}" is not a number; dropped`);
        return;
      }
      attrs[rule.attr] = n;
      return;
    }
    case "boolean": {
      const v = value.toLowerCase();
      if (v === "yes" || v === "true") attrs[rule.attr] = true;
      else if (v === "no" || v === "false") attrs[rule.attr] = false;
      else ctx.warn("VALIDATION_FAILED", `${template}: ${param}="${value}" is not a boolean; dropped`);
      return;
    }
  }
}

/**
 * Map a call's params through a rule table. Empty/whitespace values and
 * {{{...}}} passthroughs are dropped silently; unknown params warn
 * PARAM_UNKNOWN and drop. `special` may consume a param before the table.
 */
function mapParams(
  call: TemplateCall,
  ctx: MapCtx,
  table: Map<string, ParamRule>,
  special?: (key: string, value: string) => boolean,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(call.params)) {
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (value === "" || isPassthrough(value)) continue;
    if (special?.(key, value)) continue;
    const rule = table.get(key);
    if (!rule) {
      ctx.warn("PARAM_UNKNOWN", `{{${call.name}}}: unknown parameter "${rawKey}"; dropped`, { value });
      continue;
    }
    applyRule(rule, value, attrs, ctx, call.name, rawKey);
  }
  return attrs;
}

function positional(call: TemplateCall, n: number): string {
  return (call.params[String(n)] ?? "").trim();
}

// ---------------------------------------------------------------------------
// Per-template mappers

function mapPrototype(call: TemplateCall, ctx: MapCtx): MappingResult {
  let nameFallback: string | undefined;
  let releaseDateRaw: string | undefined;
  const attrs = mapParams(call, ctx, PROTOTYPE_RULES, (key, value) => {
    if (key === "name") {
      nameFallback = value;
      return true;
    }
    if (key === "release_date") {
      releaseDateRaw = value;
      return true;
    }
    return false;
  });
  if (releaseDateRaw !== undefined) {
    const dates = parseReleaseDates(releaseDateRaw, ctx);
    if (dates.length > 0) attrs.releaseDate = dates;
  }
  if (attrs.game === undefined && nameFallback !== undefined) attrs.game = nameFallback;
  return { kind: "component", name: "Prototype", attrs };
}

/** {{RegionDate|REGION|DATE}} sequences (plus stray prose) -> {region,date}[]. */
function parseReleaseDates(wikitext: string, ctx: MapCtx): { region: string; date: string }[] {
  const out: { region: string; date: string }[] = [];
  for (const part of ctx.parseCalls(wikitext)) {
    if (typeof part === "string") {
      const text = part.trim();
      if (text !== "") out.push({ region: "", date: text });
    } else if (part.name.toLowerCase() === "regiondate") {
      const region = (part.params["1"] ?? "").trim();
      const raw = (part.params["2"] ?? "").trim();
      out.push({ region, date: raw === "" ? "" : ctx.parseDate(raw) ?? raw });
    } else {
      ctx.warn("PARAM_UNKNOWN", `release_date: unexpected nested {{${part.name}}}; dropped`);
    }
  }
  return out;
}

function mapDownload(call: TemplateCall, ctx: MapCtx): MappingResult {
  const attrs: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(call.params)) {
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (value === "" || isPassthrough(value)) continue;
    switch (key) {
      case "file":
        attrs.file = value;
        break;
      case "raw":
        attrs.raw = value;
        break;
      case "title":
        // The View defaults to the page title; the wikitext idiom is noise.
        if (value.toUpperCase() !== "{{PAGENAME}}") attrs.title = value;
        break;
      case "external": {
        // One bare URL or bracketed [url label] wikitext (possibly several).
        const urls = value.match(/https?:\/\/[^\s\]|]+/g);
        if (urls && urls.length > 0) attrs.external = urls;
        else ctx.warn("VALIDATION_FAILED", `{{Download}}: no URL found in external="${value}"; dropped`);
        break;
      }
      default:
        ctx.warn("PARAM_UNKNOWN", `{{${call.name}}}: unknown parameter "${rawKey}"; dropped`, { value });
    }
  }
  return { kind: "component", name: "Download", attrs };
}

/**
 * {{filelist}} wraps {{filelistentry}} calls inside its positional params.
 * MappingResult has no children field, so the block is serialized here with
 * the canonical tag codec and returned as markdown.
 */
function mapFilelist(call: TemplateCall, ctx: MapCtx): MappingResult {
  const entries: string[] = [];
  const keys = Object.keys(call.params)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b));
  for (const key of keys) {
    for (const part of ctx.parseCalls(call.params[key] ?? "")) {
      if (typeof part === "string") {
        if (part.trim() !== "") {
          ctx.warn("PARAM_UNKNOWN", `{{filelist}}: stray text "${part.trim()}"; dropped`);
        }
      } else if (part.name.toLowerCase() === "filelistentry") {
        entries.push(serializeComponentTag("FileEntry", mapParams(part, ctx, FILELISTENTRY_RULES), FileEntry));
      } else {
        ctx.warn("PARAM_UNKNOWN", `{{filelist}}: unexpected nested {{${part.name}}}; dropped`);
      }
    }
  }
  const markdown = serializeComponentTag("FileList", {}, FileList, { children: entries.join("\n") });
  return { kind: "markdown", markdown };
}

function mapVideoEmbed(call: TemplateCall, ctx: MapCtx): MappingResult {
  const raw = (call.params["youtubelink"] ?? call.params["1"] ?? "").trim();
  if (raw === "") {
    ctx.warn("VALIDATION_FAILED", "{{Video embed}} without a youtubelink; dropped");
    return { kind: "drop" };
  }
  // Full URL forms or a bare 11-char id.
  const m = raw.match(/(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|embed\/)|youtu\.be\/)([\w-]{11})/);
  return { kind: "component", name: "YouTube", attrs: { id: m?.[1] ?? raw } };
}

function mapPrototypeFooter(call: TemplateCall, ctx: MapCtx): MappingResult {
  for (const part of ctx.parseCalls(positional(call, 1))) {
    if (typeof part !== "string" && part.name.toLowerCase() === "navbox prototype") {
      return { kind: "component", name: "GameNav", attrs: { game: (part.params["1"] ?? "").trim() }, placement: "block" };
    }
  }
  ctx.warn("UNMAPPED_TEMPLATE", "{{Prototype Footer}} without a {{Navbox prototype}}; dropped");
  return { kind: "drop" };
}

// ---------------------------------------------------------------------------
// The mapping

export const hpMapping: TemplateMapping = {
  map(call: TemplateCall, ctx: MapCtx): MappingResult {
    if (call.kind === "function") {
      if (FUNCTION_DROPS.has(call.name.toLowerCase())) return { kind: "drop" };
      ctx.warn("UNMAPPED_TEMPLATE", `parser function {{#${call.name}}} kept verbatim`);
      return { kind: "verbatim" };
    }

    const name = call.name.toLowerCase();
    if (TEMPLATE_DROPS.has(name)) return { kind: "drop" };

    switch (name) {
      case "prototype":
        return mapPrototype(call, ctx);
      case "board":
        return { kind: "component", name: "Board", attrs: mapParams(call, ctx, BOARD_RULES) };
      case "video":
        return { kind: "component", name: "Video", attrs: mapParams(call, ctx, VIDEO_RULES) };
      case "download":
        return mapDownload(call, ctx);
      case "filelist":
        return mapFilelist(call, ctx);
      case "video embed":
        return mapVideoEmbed(call, ctx);
      case "regiondate":
        return {
          kind: "component",
          name: "RegionDate",
          attrs: { region: positional(call, 1), date: positional(call, 2) },
          placement: "inline",
        };
      case "tcrf link":
        return {
          kind: "component",
          name: "TcrfLink",
          attrs: { page: positional(call, 1) },
          placement: "block",
        };
      case "prototype footer":
        return mapPrototypeFooter(call, ctx);
      case "navbox prototype":
        return { kind: "component", name: "GameNav", attrs: { game: positional(call, 1) }, placement: "block" };
      case "hardware system":
        return { kind: "component", name: "HardwareSystem", attrs: { system: positional(call, 1) } };
    }

    ctx.warn("UNMAPPED_TEMPLATE", `{{${call.name}}} kept as expanded HTML`);
    return { kind: "keep-html" };
  },
};

// ---------------------------------------------------------------------------
// #ask -> <Query>

/** SMW "Has article type" values -> component names for `from`. */
const ARTICLE_TYPE_FROM: Record<string, string> = {
  prototype: "Prototype",
  video: "Video",
  board: "Board",
  lot: "Lot",
  "disc type": "Board",
  "dev kit": "Board",
  demo: "Prototype",
  assets: "Video",
};

/** Article types whose component target is an approximation. */
const APPROX_ARTICLE_TYPES = new Set(["disc type", "dev kit", "demo", "assets"]);

/** Which component a condition key implies when no article type is given. */
const KEY_COMPONENT_HINTS: Record<string, string> = {
  origin_lot: "Prototype",
  origin_board: "Prototype",
  build_date: "Prototype",
  file_release_date: "Prototype",
  video_date: "Video",
  hardware_id: "Board",
  hardware_type: "Board",
  hardware_date: "Board",
};

/** SMW property names -> extracted data keys. */
const PROPERTY_KEYS: Record<string, string> = {
  "has game": "game",
  "has system": "system",
  "has genre": "genre",
  "has video date": "video_date",
  "has build date": "build_date",
  "has origin lot": "origin_lot",
  "has board": "origin_board",
  "has hardware type": "hardware_type",
  "has hardware date": "hardware_date",
  "has hardware id": "hardware_id",
  "has file release date": "file_release_date",
  "creation date": "_created",
  "modification date": "_modified",
};

/**
 * Translate one preparsed {{#ask:}} into a <Query> component. The pipeline
 * calls this (instead of hpMapping.map) for function calls named ask/show.
 */
export function mapAsk(ask: AskQuery, ctx: MapCtx): MappingResult {
  const from: string[] = [];
  const where: Record<string, unknown> = {};

  for (const m of ask.conditions.matchAll(/\[\[([^\]]*)\]\]/g)) {
    const body = (m[1] ?? "").trim();
    const sep = body.indexOf("::");
    if (sep < 0) {
      ctx.warn("ASK_UNSUPPORTED", `condition [[${body}]] not understood; dropped`);
      continue;
    }
    const property = body.slice(0, sep).trim();
    const value = body.slice(sep + 2).trim();

    if (property.toLowerCase() === "has article type") {
      // Article types select the component(s) to query, not a where key.
      for (const alt of splitList(value, "||")) {
        const target = ARTICLE_TYPE_FROM[alt.toLowerCase()];
        if (!target) {
          ctx.warn("ASK_UNSUPPORTED", `unknown article type "${alt}"; dropped`);
          continue;
        }
        if (APPROX_ARTICLE_TYPES.has(alt.toLowerCase())) {
          ctx.warn("ASK_UNSUPPORTED", `article type "${alt}" approximated as component ${target}`);
        }
        if (!from.includes(target)) from.push(target);
      }
      continue;
    }

    const key = PROPERTY_KEYS[property.toLowerCase()];
    if (!key) {
      ctx.warn("ASK_UNSUPPORTED", `unsupported property "${property}"; condition dropped`);
      continue;
    }
    if (value === "+") {
      where[key] = { exists: true };
      // Existence probes on hardware ids are how board listings are built.
      if (key === "hardware_id" && !from.includes("Board")) from.push("Board");
    } else if (/^[<>!~]/.test(value)) {
      ctx.warn("ASK_UNSUPPORTED", `comparator condition "${property}::${value}" not supported; dropped`);
    } else {
      const alts = splitList(value, "||");
      if (alts.length > 1) where[key] = { in: alts };
      else where[key] = alts[0] ?? value;
    }
  }

  if (from.length === 0) {
    // No article-type condition (lot pages: just [[Has origin lot::X]]) -
    // infer the component from which data keys the conditions reference.
    for (const key of Object.keys(where)) {
      const inferred = KEY_COMPONENT_HINTS[key];
      if (inferred && !from.includes(inferred)) from.push(inferred);
    }
    if (from.length > 0) {
      ctx.warn("ASK_UNSUPPORTED", `#ask component inferred from condition keys: ${from.join(", ")}`);
    }
  }
  if (from.length === 0) {
    ctx.warn("ASK_UNSUPPORTED", "no queryable component derivable from #ask conditions; kept verbatim");
    return { kind: "verbatim" };
  }

  const attrs: Record<string, unknown> = { from: from.length === 1 ? from[0] : from };
  if (Object.keys(where).length > 0) attrs.where = where;

  const select: string[] = [];
  const headers: string[] = [];
  for (const p of ask.printouts) {
    const key = PROPERTY_KEYS[p.property.trim().toLowerCase()];
    if (!key) {
      ctx.warn("ASK_UNSUPPORTED", `printout "?${p.property}" has no mapped data key; skipped`);
      continue;
    }
    select.push(key);
    headers.push(p.label ?? key);
  }
  if (select.length > 0) {
    attrs.select = select;
    attrs.headers = headers;
  }

  const format = ask.format?.toLowerCase();
  if (format === "count") {
    attrs.format = "count";
  } else if (format === "ul") {
    attrs.format = "ul";
  } else if (format === "template") {
    attrs.format = "render";
    if (ask.template) {
      attrs.render = ask.template;
      ctx.warn("ASK_UNSUPPORTED", `format=template mapped to render="${ask.template}"; the site renderer must exist`);
    } else {
      ctx.warn("ASK_UNSUPPORTED", "format=template without a template name; falling back to default rendering");
    }
  } else if (format !== undefined && format !== "table" && format !== "broadtable") {
    ctx.warn("ASK_UNSUPPORTED", `#ask format "${ask.format}" not mapped; using the default table`);
  }

  if (ask.sort && ask.sort.length > 0) {
    const sort: { field: string; dir: "asc" | "desc" }[] = [];
    ask.sort.forEach((s, i) => {
      const key = PROPERTY_KEYS[s.trim().toLowerCase()];
      if (!key) {
        ctx.warn("ASK_UNSUPPORTED", `sort on unmapped property "${s}"; skipped`);
        return;
      }
      sort.push({ field: key, dir: (ask.order?.[i] ?? "asc").toLowerCase() === "desc" ? "desc" : "asc" });
    });
    if (sort.length > 0) attrs.sort = sort;
  }

  if (ask.limit !== undefined) attrs.limit = ask.limit;

  for (const key of Object.keys(ask.extra)) {
    ctx.warn("ASK_UNSUPPORTED", `#ask parameter "${key}" ignored`);
  }

  return { kind: "component", name: "Query", attrs };
}
