/**
 * Parse-only frontend: markdown + GFM + JSX-style component tags + wiki links.
 *
 * Content is data. JSX syntax is tokenized by micromark-extension-mdx-jsx but
 * nothing is ever compiled or evaluated; brace attribute values are parsed as
 * strict JSON downstream (src/mdx.ts). MDX *expression* syntax is not enabled,
 * so braces in prose stay literal text.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mdxJsxFromMarkdown } from "mdast-util-mdx-jsx";
import { gfm } from "micromark-extension-gfm";
import { mdxJsx } from "micromark-extension-mdx-jsx";
import { Parser } from "acorn";
import type { Node, Parent, Root, Text } from "mdast";
import type { Node as UnistNode } from "unist";
import type { Issue } from "./issues";

/** Custom inline node produced from [[Target|label]] syntax. */
export type WikiLink = UnistNode & {
  type: "wikiLink";
  target: string;
  /** Explicit label; undefined means display the target. Empty string = MW pipe trick (display target sans namespace/parens). */
  label?: string;
  position?: Text["position"];
};

// Declaration merging into mdast's node maps requires interface syntax;
// type aliases cannot augment an existing interface.
declare module "mdast" {
  interface PhrasingContentMap {
    wikiLink: WikiLink;
  }
  interface RootContentMap {
    wikiLink: WikiLink;
  }
}

export type ParseResult = {
  root: Root | null;
  issues: Issue[];
};

const WIKILINK_RE = /\[\[([^[\]\n|]+?)(?:\|([^[\]\n]*))?\]\]/g;

export function parseDocument(markdown: string): ParseResult {
  let root: Root;
  try {
    root = fromMarkdown(markdown, {
      extensions: [gfm(), mdxJsx({ acorn: Parser, addResult: false })],
      mdastExtensions: [gfmFromMarkdown(), mdxJsxFromMarkdown()],
    });
  } catch (err) {
    const issue: Issue = {
      severity: "error",
      rule: "parse",
      message: messageOf(err),
    };
    const place = (err as { place?: { line?: number; column?: number } }).place;
    if (place?.line) {
      issue.line = place.line;
      issue.column = place.column;
    }
    return { root: null, issues: [issue] };
  }

  transformWikiLinks(root);
  return { root, issues: [] };
}

function messageOf(err: unknown): string {
  const raw =
    err && typeof err === "object" && "reason" in err && typeof err.reason === "string"
      ? err.reason
      : err instanceof Error
        ? err.message
        : String(err);
  // The mdx-jsx tokenizer's message for `<!--` suggests MDX expression
  // comments, which cube doesn't support: rewrite to something actionable.
  if (raw.includes("Unexpected character `!` (U+0021) before name")) {
    return "HTML comments (<!-- -->) are not supported; remove the comment or move the note into prose";
  }
  return raw;
}

/* ---- wiki links ---------------------------------------------------------- */

function transformWikiLinks(root: Root): void {
  walk(root as unknown as Parent);
}

function walk(parent: Parent): void {
  const out: Node[] = [];
  let changed = false;
  for (const child of parent.children as Node[]) {
    if (child.type === "text") {
      const pieces = splitText(child as Text);
      if (pieces) {
        out.push(...pieces);
        changed = true;
        continue;
      }
    }
    if ("children" in child && Array.isArray((child as Parent).children)) {
      walk(child as Parent);
    }
    out.push(child);
  }
  if (changed) parent.children = out as never;
}

function splitText(node: Text): Node[] | null {
  const value = node.value;
  WIKILINK_RE.lastIndex = 0;
  if (!WIKILINK_RE.test(value)) return null;
  WIKILINK_RE.lastIndex = 0;

  // Positions are exact when the text node's source span length matches its
  // value (no entity/escape decoding inside); otherwise pieces inherit the
  // node's start position, which is still line-accurate for validation.
  const start = node.position?.start;
  const end = node.position?.end;
  const exact =
    start?.offset !== undefined &&
    end?.offset !== undefined &&
    end.offset - start.offset === value.length &&
    start.line === end.line;

  const pieces: Node[] = [];
  let last = 0;
  for (let m = WIKILINK_RE.exec(value); m; m = WIKILINK_RE.exec(value)) {
    if (m.index > last) {
      pieces.push(textPiece(node, value.slice(last, m.index), last, m.index, exact));
    }
    const link: WikiLink = {
      type: "wikiLink",
      target: m[1]!.trim(),
      ...(m[2] !== undefined ? { label: m[2] } : {}),
    };
    if (node.position) {
      link.position = exact
        ? {
            start: point(start!, m.index),
            end: point(start!, m.index + m[0].length),
          }
        : { start: { ...node.position.start }, end: { ...node.position.end } };
    }
    pieces.push(link as unknown as Node);
    last = m.index + m[0].length;
  }
  if (last < value.length) {
    pieces.push(textPiece(node, value.slice(last), last, value.length, exact));
  }
  return pieces;
}

function textPiece(node: Text, value: string, from: number, to: number, exact: boolean): Node {
  const t: Text = { type: "text", value };
  if (node.position) {
    t.position = exact
      ? { start: point(node.position.start, from), end: point(node.position.start, to) }
      : { start: { ...node.position.start }, end: { ...node.position.end } };
  }
  return t;
}

function point(
  start: { line: number; column: number; offset?: number },
  delta: number,
): { line: number; column: number; offset?: number } {
  return {
    line: start.line,
    column: start.column + delta,
    ...(start.offset !== undefined ? { offset: start.offset + delta } : {}),
  };
}
