/** Shared helpers for mdx-jsx nodes: attribute extraction without evaluation. */

import type { MdxJsxFlowElement, MdxJsxTextElement } from "mdast-util-mdx-jsx";

export type JsxElement = MdxJsxFlowElement | MdxJsxTextElement;

export type RawAttrError = {
  attr?: string;
  message: string;
};

export type RawAttrsResult = {
  attrs: Record<string, unknown>;
  errors: RawAttrError[];
};

/**
 * Extract raw attribute values from a JSX element node.
 * String attrs stay strings; brace attrs must be strict JSON literals
 * (parsed with JSON.parse: never evaluated); bare attrs become true.
 */
export function rawAttrs(node: JsxElement): RawAttrsResult {
  const attrs: Record<string, unknown> = {};
  const errors: RawAttrError[] = [];

  for (const a of node.attributes) {
    if (a.type === "mdxJsxExpressionAttribute") {
      errors.push({ message: "spread attributes ({...x}) are not allowed" });
      continue;
    }
    if (a.name in attrs) {
      errors.push({ attr: a.name, message: `duplicate attribute "${a.name}"` });
      continue;
    }
    if (a.value === null || a.value === undefined) {
      attrs[a.name] = true; // bare attribute
    } else if (typeof a.value === "string") {
      attrs[a.name] = a.value;
    } else {
      // mdxJsxAttributeValueExpression: raw source between the braces.
      const raw = a.value.value.trim();
      try {
        attrs[a.name] = JSON.parse(raw);
      } catch {
        errors.push({
          attr: a.name,
          message: `attribute "${a.name}" must be a JSON literal (got {${truncate(raw, 40)}})`,
        });
      }
    }
  }

  return { attrs, errors };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function isJsxElement(node: { type: string }): node is JsxElement {
  return node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";
}

/** Component tags are Capitalized; lowercase JSX names are intrinsic (html-ish) tags. */
export function isComponentName(name: string | null | undefined): name is string {
  return typeof name === "string" && /^[A-Z]/.test(name);
}
