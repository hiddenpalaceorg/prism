/**
 * Canonical component-tag codec, shared by the save pipeline, the editor's
 * markdown round-trip, and the MediaWiki converter. Serialization is
 * deterministic: schema attribute order, plain strings quoted, everything
 * else a strict-JSON brace value.
 */

import type { ComponentSpec } from "./schema/index";
import { isComponentName, isJsxElement, rawAttrs } from "./mdx";
import { parseDocument } from "./parse";

/** True when a string value can serialize as name="value" without loss. */
function quotable(v: string): boolean {
  return !v.includes('"') && !v.includes("\n") && v === v.trim() || v === "";
}

export function serializeAttr(name: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    if (quotable(value)) return `${name}="${value}"`;
    return `${name}={${JSON.stringify(value)}}`;
  }
  return `${name}={${JSON.stringify(value)}}`;
}

export type SerializeTagOptions = {
  /** Children markdown to place between open/close tags. */
  children?: string;
};

export function serializeComponentTag(
  name: string,
  attrs: Record<string, unknown>,
  spec?: ComponentSpec,
  opts: SerializeTagOptions = {},
): string {
  const order: string[] = [];
  const seen = new Set<string>();
  if (spec) {
    for (const key of Object.keys(spec.attrs)) {
      if (key in attrs) {
        order.push(key);
        seen.add(key);
      }
    }
  }
  for (const key of Object.keys(attrs).filter((k) => !seen.has(k)).sort()) {
    order.push(key);
  }

  const parts: string[] = [`<${name}`];
  for (const key of order) {
    const s = serializeAttr(key, attrs[key]);
    if (s !== null) parts.push(s);
  }
  const open = parts.join(" ");

  if (opts.children !== undefined) {
    return `${open}>\n${opts.children}\n</${name}>`;
  }
  return `${open} />`;
}

export type ParsedTag = {
  name: string;
  attrs: Record<string, unknown>;
  hasChildren: boolean;
};

export type ParseTagError = { error: string };

/**
 * Parse a single component tag snippet (as the editor's node codec does).
 * Uses the real document parser so behavior can never diverge from saves.
 */
export function parseComponentTag(src: string): ParsedTag | ParseTagError {
  const { root, issues } = parseDocument(src.trim());
  if (!root) return { error: issues[0]?.message ?? "parse failed" };

  let node = root.children.length === 1 ? root.children[0]! : null;
  // An inline component parses as a paragraph wrapping one text element.
  if (node?.type === "paragraph" && node.children.length === 1) {
    node = node.children[0]! as never;
  }
  if (!node || !isJsxElement(node)) return { error: "not a single component tag" };
  if (!isComponentName(node.name)) return { error: "not a component (lowercase tag)" };

  const { attrs, errors } = rawAttrs(node);
  if (errors.length > 0) return { error: errors[0]!.message };
  return { name: node.name, attrs, hasChildren: node.children.length > 0 };
}
