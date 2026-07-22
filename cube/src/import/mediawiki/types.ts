/**
 * MediaWiki converter contracts.
 *
 * Input is Parsoid HTML (core REST v1 with_html; data-mw inline). Template
 * ARGUMENTS are read verbatim from data-mw parts, never from the expansion,
 * so conversion is version-safe for mapped templates. The site supplies a
 * TemplateMapping deciding what each template call becomes.
 */

export type WarningCode =
  | "UNMAPPED_TEMPLATE"
  | "PARAM_UNKNOWN"
  | "TEMPLATE_DELETED"
  | "TEMPLATE_EXPANDED_CURRENT"
  | "LOST_TABLE_ATTRS"
  | "RAW_HTML_DROPPED"
  | "RAW_HTML_KEPT"
  | "PARSE_FAILED_VERBATIM"
  | "DATE_UNPARSEABLE"
  | "ASK_UNSUPPORTED"
  | "EXTENSION_UNSUPPORTED"
  | "VALIDATION_FAILED";

export interface ConversionWarning {
  code: WarningCode;
  message: string;
  severity: "info" | "warning" | "error";
  detail?: unknown;
}

/** One template or parser-function call, args verbatim from the revision. */
export interface TemplateCall {
  kind: "template" | "function";
  /** Normalized name: no Template: prefix, first-cap, underscores as spaces,
   * trailing whitespace stripped. Parser functions lowercase without '#'. */
  name: string;
  /** Named + positional params (positional keys "1", "2", ...). Values are
   * raw wikitext. Named param values arrive whitespace-trimmed from Parsoid;
   * positional ones do not (probe finding): mapping code trims as needed. */
  params: Record<string, string>;
}

/** What a template call becomes in the output document. */
export type MappingResult =
  | {
      kind: "component";
      name: string;
      attrs: Record<string, unknown>;
      /** Placement of the emitted tag. Default "block". */
      placement?: "block" | "inline";
      /** Fenced-JSON child content (HexDump-style children: "json"). */
      childrenJson?: unknown;
    }
  | { kind: "markdown"; markdown: string }
  | { kind: "keep-html" }
  | { kind: "drop" }
  | { kind: "verbatim" };

export interface MapCtx {
  pageTitle: string;
  warn(code: WarningCode, message: string, detail?: unknown): void;
  /** Split a param's raw wikitext into literal text and nested calls
   * (balanced-brace aware; handles {{RegionDate|...}} inside params). */
  parseCalls(wikitext: string): Array<string | TemplateCall>;
  /** MW-style fuzzy date ("Sep 29, 1992", "1992", "May 1992") to ISO partial.
   * Returns null when unparseable (caller warns DATE_UNPARSEABLE). */
  parseDate(text: string): string | null;
}

export interface TemplateMapping {
  /** Decide what one call becomes. Called once per about-group. */
  map(call: TemplateCall, ctx: MapCtx): MappingResult;
}

export interface ConvertOptions {
  pageTitle: string;
  mapping: TemplateMapping;
  /** "drop" (default): categories only collected into the result;
   * "keep": also emitted as <Category> tags. */
  categories?: "drop" | "keep";
}

export interface ConversionResult {
  /** Converted markdown, or null when conversion failed hard
   * (caller stores the original wikitext with wikitext_fallback). */
  markdown: string | null;
  ok: boolean;
  warnings: ConversionWarning[];
  /** Raw category titles found on the page (MW categorylinks side channel). */
  categories: string[];
}

/** Parsed representation of one {{#ask:}} call. */
export interface AskQuery {
  /** Raw condition string(s), e.g. "[[Has article type::Video]]". */
  conditions: string;
  /** Printouts: ?Has game=Game -> { property: "Has game", label: "Game" }. */
  printouts: { property: string; label?: string }[];
  format?: string;
  limit?: number;
  sort?: string[];
  order?: string[];
  template?: string;
  mainlabel?: string;
  /** Any parameters not otherwise recognized. */
  extra: Record<string, string>;
}
