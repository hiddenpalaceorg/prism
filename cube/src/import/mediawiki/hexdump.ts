/**
 * Structured parsing of the wiki's hex-snippet HTML (==Header== sections).
 *
 * romutils.py emits machine-generated raw inline HTML:
 *
 *   <span class="hex-snippet">00000100  <span class="hover-link ..."
 *     data-title="System name" title="Sega Mega Drive">53 45 47 41 ...</span> ...
 *
 * Offset-prefixed hexdump lines (16 bytes: hex column, then an ASCII column)
 * where hover-link sub-spans annotate byte ranges: data-title is the field
 * name, title is the decoded value. The ASCII column repeats the same
 * annotations, so only hex-area spans produce annotation entries. One
 * hex-snippet span may hold a whole multi-line dump (newlines in its text
 * nodes) or each line may be its own snippet; consecutive sibling snippets
 * are grouped into one dump.
 *
 * Parsing is tolerant: a group that does not scan as a hexdump is returned
 * with data = null so the caller can keep the original markup (RAW_HTML_KEPT).
 */

import type {
  Element as HastElement,
  Nodes as HastNodes,
  Parents as HastParents,
  Root as HastRoot,
} from "hast";

export interface HexDumpLine {
  /** Offset column verbatim (e.g. "00000100"). */
  offset: string;
  /** Hex bytes normalized to single-space separation ("53 45 47 41 ..."). */
  bytes: string;
  /** ASCII column verbatim, when present. */
  ascii?: string;
}

export interface HexDumpAnnotation {
  /** Index into HexDumpData.lines. */
  line: number;
  /** First annotated byte (byte index within the line's hex bytes). */
  start: number;
  /** Annotated byte count. */
  length: number;
  /** Field name (the span's data-title). */
  field: string;
  /** Decoded value (the span's title). */
  value: string;
}

export interface HexDumpData {
  lines: HexDumpLine[];
  annotations: HexDumpAnnotation[];
}

export interface HexSnippetGroup {
  /** The hex-snippet elements of the group, in document order. */
  snippets: HastElement[];
  /** Contiguous sibling range covered (snippets plus separators between
   * them): the nodes the caller replaces. References into the tree. */
  nodes: HastNodes[];
  /** The parent whose children contain `nodes`. */
  parent: HastParents;
  /** Parsed dump, or null when unparseable (caller keeps the markup). */
  data: HexDumpData | null;
}

const BYTES_PER_LINE = 16;
/** Columns are separated by at most two spaces; wider gaps are padding. */
const MAX_GAP = 2;

/* ---- tree scan ---------------------------------------------------------- */

function isHexSnippet(node: HastNodes): node is HastElement {
  if (node.type !== "element") return false;
  const cls: unknown = node.properties?.className;
  let names: string[] = [];
  if (Array.isArray(cls)) names = cls.map(String);
  else if (typeof cls === "string") names = cls.split(/\s+/);
  return names.includes("hex-snippet");
}

/** Whitespace text and <br> may sit between adjacent lines of one dump. */
function isSeparator(node: HastNodes): boolean {
  if (node.type === "text") return node.value.trim() === "";
  return node.type === "element" && node.tagName === "br";
}

/**
 * Find hex-snippet elements and group consecutive siblings (separated only
 * by whitespace/<br>) into one dump each. Returned node references point
 * into `root`; the caller performs the actual tree edits.
 */
export function parseHexSnippets(root: HastRoot): HexSnippetGroup[] {
  const groups: HexSnippetGroup[] = [];

  const visit = (node: HastNodes): void => {
    if (!("children" in node)) return;
    const parent = node as HastParents;
    const children = parent.children as HastNodes[];
    let i = 0;
    while (i < children.length) {
      if (!isHexSnippet(children[i]!)) {
        visit(children[i]!);
        i++;
        continue;
      }
      const start = i;
      let end = i + 1; // index after the last snippet of the run
      const snippets: HastElement[] = [];
      while (i < children.length) {
        const child = children[i]!;
        if (isHexSnippet(child)) {
          snippets.push(child);
          end = i + 1;
          i++;
          continue;
        }
        if (isSeparator(child)) {
          i++;
          continue;
        }
        break;
      }
      const nodes = children.slice(start, end);
      groups.push({ snippets, nodes, parent, data: parseGroup(snippets) });
    }
  };
  visit(root);
  return groups;
}

/* ---- snippet flattening -------------------------------------------------- */

/** One run of text; annotated when it came from a hover-link span. */
interface Segment {
  text: string;
  field?: string;
  value?: string;
}

function textOf(node: HastNodes): string {
  if (node.type === "text") return node.value;
  if ("children" in node) return (node.children as HastNodes[]).map(textOf).join("");
  return "";
}

function segmentsOf(snippets: HastElement[]): Segment[] {
  const segs: Segment[] = [];
  const pushText = (t: string) => {
    if (t !== "") segs.push({ text: t });
  };
  snippets.forEach((snippet, idx) => {
    if (idx > 0) pushText("\n"); // sibling snippets are separate lines
    for (const child of snippet.children as HastNodes[]) {
      if (child.type === "text") {
        pushText(child.value);
        continue;
      }
      if (child.type !== "element") continue;
      if (child.tagName === "br") {
        pushText("\n");
        continue;
      }
      const props = child.properties ?? {};
      const field = props.dataTitle;
      const value = props.title;
      const text = textOf(child);
      if (typeof field === "string" && typeof value === "string") {
        segs.push({ text, field, value });
      } else {
        pushText(text);
      }
    }
  });
  return segs;
}

/** Split segments at newlines into per-line segment lists (blank lines dropped). */
function splitLines(segs: Segment[]): Segment[][] {
  const lines: Segment[][] = [[]];
  for (const seg of segs) {
    const parts = seg.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part !== "") lines[lines.length - 1]!.push({ ...seg, text: part });
    });
  }
  return lines.filter((line) => line.some((s) => s.text.trim() !== ""));
}

/* ---- line parsing --------------------------------------------------------- */

interface ParsedLine {
  line: HexDumpLine;
  annotations: Omit<HexDumpAnnotation, "line">[];
}

function parseLine(segs: Segment[]): ParsedLine | null {
  const text = segs.map((s) => s.text).join("");

  const offsetMatch = /^([0-9A-Fa-f]{4,16}):? {1,2}/.exec(text);
  if (!offsetMatch) return null;

  // Hex area: byte tokens (2 hex chars) separated by 1-2 spaces, at most 16
  // per line. A wider gap or a non-byte token starts the ASCII column (which
  // can itself contain hex-looking text, hence the byte cap).
  const byteRanges: { start: number; end: number }[] = [];
  const cursor = offsetMatch[0].length;
  let hexEnd = cursor;
  const tokenRe = /[^ ]+/g;
  tokenRe.lastIndex = cursor;
  for (let m = tokenRe.exec(text); m !== null; m = tokenRe.exec(text)) {
    if (byteRanges.length >= BYTES_PER_LINE) break;
    if (!/^[0-9A-Fa-f]{2}$/.test(m[0])) break;
    if (m.index - hexEnd > MAX_GAP) break;
    byteRanges.push({ start: m.index, end: m.index + 2 });
    hexEnd = m.index + 2;
  }
  if (byteRanges.length === 0) return null;

  // ASCII column: skip the (up to two space) separator, keep the rest verbatim
  // (it may legitimately start with spaces: space bytes render as spaces).
  let asciiStart = hexEnd;
  for (let skipped = 0; skipped < MAX_GAP && text[asciiStart] === " "; skipped++) asciiStart++;
  const ascii = text.slice(asciiStart);

  // Annotations: hex-area spans map to byte indexes; ASCII-column spans repeat
  // the same field/value and are skipped.
  const raw: Omit<HexDumpAnnotation, "line">[] = [];
  let pos = 0;
  for (const seg of segs) {
    const s = pos;
    const e = pos + seg.text.length;
    pos = e;
    if (seg.field === undefined || seg.value === undefined) continue;
    const first = byteRanges.findIndex((r) => r.end > s);
    if (first === -1 || byteRanges[first]!.start >= e) continue; // not in the hex area
    let last = first;
    while (last + 1 < byteRanges.length && byteRanges[last + 1]!.start < e) last++;
    raw.push({ start: first, length: last - first + 1, field: seg.field, value: seg.value });
  }

  // Merge adjacent spans carrying the same field/value (romutils splits each
  // 16-byte range into 8-byte column groups).
  const merged: Omit<HexDumpAnnotation, "line">[] = [];
  for (const a of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.field === a.field && prev.value === a.value && prev.start + prev.length === a.start) {
      prev.length += a.length;
    } else {
      merged.push({ ...a });
    }
  }

  return {
    line: {
      offset: offsetMatch[1]!,
      bytes: byteRanges.map((r) => text.slice(r.start, r.end)).join(" "),
      ...(ascii !== "" && { ascii }),
    },
    annotations: merged,
  };
}

function parseGroup(snippets: HastElement[]): HexDumpData | null {
  const lines = splitLines(segmentsOf(snippets));
  if (lines.length === 0) return null;
  const out: HexDumpLine[] = [];
  const annotations: HexDumpAnnotation[] = [];
  for (const segs of lines) {
    const parsed = parseLine(segs);
    if (parsed === null) return null; // one bad line -> keep the whole group as text
    annotations.push(...parsed.annotations.map((a) => ({ line: out.length, ...a })));
    out.push(parsed.line);
  }
  return { lines: out, annotations };
}
