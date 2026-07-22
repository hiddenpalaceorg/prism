/**
 * Save-time document validation against the component registry.
 * Produces line-accurate issues and the normalized component instances
 * that extraction (src/extract.ts) consumes.
 */

import type { Code, Node, Parent, Root } from "mdast";
import { visit } from "unist-util-visit";
import type { Issue } from "./issues";
import { at } from "./issues";
import { isComponentName, isJsxElement, rawAttrs, type JsxElement } from "./mdx";
import type { PageRef, Registry } from "./schema/index";
import { normalizeAttrs } from "./schema/index";

export interface ComponentInstance {
  name: string;
  /** Normalized, schema-typed attr values (defaults applied). */
  attrs: Record<string, unknown>;
  /** Document-order position among all component instances on the page. */
  ordinal: number;
  /** Parsed fenced-JSON child, for components with children: "json". */
  childrenJson?: unknown;
  node: JsxElement;
}

export interface ValidateOptions {
  /** How to treat components missing from the registry. Default "error". */
  unknownComponents?: "error" | "warning";
  /** Lowercase JSX tags allowed to render as real elements. */
  intrinsicTags?: readonly string[];
  /** How to treat raw markdown HTML nodes. Default "warning" (rendered escaped). */
  rawHtml?: "error" | "warning";
}

export const DEFAULT_INTRINSIC_TAGS: readonly string[] = [
  "b", "i", "em", "strong", "u", "s", "del", "sub", "sup",
  "code", "br", "small", "abbr", "kbd", "mark", "wbr",
];

const INTRINSIC_ALLOWED_ATTRS = new Set(["class", "title", "id"]);

export interface ValidationResult {
  issues: Issue[];
  components: ComponentInstance[];
}

export function validateDocument(
  registry: Registry,
  root: Root,
  page: PageRef,
  opts: ValidateOptions = {},
): ValidationResult {
  const issues: Issue[] = [];
  const components: ComponentInstance[] = [];
  const unknownSeverity = opts.unknownComponents ?? "error";
  const intrinsics = new Set(opts.intrinsicTags ?? DEFAULT_INTRINSIC_TAGS);
  let ordinal = 0;

  visit(root, (node) => {
    if (node.type === "html") {
      issues.push(
        at(
          {
            severity: opts.rawHtml ?? "warning",
            rule: "raw-html",
            message: "raw HTML is not rendered; it will appear as literal text",
          },
          node.position,
        ),
      );
      return;
    }
    if ((node.type as string) === "mdxFlowExpression" || (node.type as string) === "mdxTextExpression") {
      issues.push(
        at(
          {
            severity: "error",
            rule: "expression",
            message: "JavaScript expressions are not allowed in content",
          },
          (node as Node).position,
        ),
      );
      return;
    }
    if (!isJsxElement(node as Node)) return;
    const el = node as JsxElement;

    if (!isComponentName(el.name)) {
      validateIntrinsic(el, intrinsics, issues);
      return;
    }

    const spec = registry.get(el.name);
    if (!spec) {
      issues.push(
        at(
          {
            severity: unknownSeverity,
            rule: "unknown-component",
            message: `unknown component <${el.name}>`,
            component: el.name,
          },
          el.position,
        ),
      );
      return;
    }

    // Placement: flow elements are block placement, text elements inline.
    const actual = el.type === "mdxJsxFlowElement" ? "block" : "inline";
    if (actual !== spec.placement) {
      issues.push(
        at(
          {
            severity: "error",
            rule: "placement",
            message: `<${el.name}> is ${spec.placement}-level but used ${actual === "block" ? "as a block" : "inline"}`,
            component: el.name,
          },
          el.position,
        ),
      );
    }

    const raw = rawAttrs(el);
    for (const e of raw.errors) {
      issues.push(
        at(
          { severity: "error", rule: "attr-syntax", message: e.message, component: el.name, attr: e.attr },
          el.position,
        ),
      );
    }

    const normalized = normalizeAttrs(spec, raw.attrs, { page });
    for (const e of normalized.errors) {
      issues.push(
        at(
          { severity: "error", rule: "attr", message: e.message, component: el.name, attr: e.attr },
          el.position,
        ),
      );
    }

    const instance: ComponentInstance = {
      name: el.name,
      attrs: normalized.values,
      ordinal: ordinal++,
      node: el,
    };

    validateChildren(el, spec.children ?? "none", registry, issues, instance);
    components.push(instance);
  });

  return { issues, components };
}

function validateIntrinsic(el: JsxElement, allowed: Set<string>, issues: Issue[]): void {
  const name = el.name ?? "";
  if (!allowed.has(name)) {
    issues.push(
      at(
        {
          severity: "error",
          rule: "intrinsic-tag",
          message: `<${name || "fragment"}> is not an allowed tag`,
        },
        el.position,
      ),
    );
    return;
  }
  for (const a of el.attributes) {
    if (a.type === "mdxJsxExpressionAttribute") {
      issues.push(
        at(
          { severity: "error", rule: "intrinsic-attr", message: "spread attributes are not allowed" },
          el.position,
        ),
      );
      continue;
    }
    if (/^on/i.test(a.name) || !INTRINSIC_ALLOWED_ATTRS.has(a.name)) {
      issues.push(
        at(
          {
            severity: "error",
            rule: "intrinsic-attr",
            message: `attribute "${a.name}" is not allowed on <${name}>`,
            attr: a.name,
          },
          el.position,
        ),
      );
    }
  }
}

function validateChildren(
  el: JsxElement,
  policy: NonNullable<import("./schema/index").ComponentSpec["children"]>,
  registry: Registry,
  issues: Issue[],
  instance: ComponentInstance,
): void {
  const meaningful = el.children.filter(
    (c) => !(c.type === "text" && (c as { value?: string }).value?.trim() === ""),
  );

  if (policy === "markdown") return;

  if (policy === "none") {
    if (meaningful.length > 0) {
      issues.push(
        at(
          {
            severity: "error",
            rule: "children",
            message: `<${el.name}> does not take children; use a self-closing tag`,
            component: el.name!,
          },
          el.position,
        ),
      );
    }
    return;
  }

  if (policy === "json") {
    const code = meaningful.length === 1 && meaningful[0]!.type === "code" ? (meaningful[0] as Code) : null;
    if (!code) {
      issues.push(
        at(
          {
            severity: "error",
            rule: "children",
            message: `<${el.name}> requires exactly one fenced JSON code block as its child`,
            component: el.name!,
          },
          el.position,
        ),
      );
      return;
    }
    try {
      instance.childrenJson = JSON.parse(code.value);
    } catch (err) {
      issues.push(
        at(
          {
            severity: "error",
            rule: "children-json",
            message: `<${el.name}> child is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
            component: el.name!,
          },
          code.position,
        ),
      );
    }
    return;
  }

  // Named-children policy: only the listed components (plus blank text) allowed.
  const allowedNames = new Set(policy);
  for (const child of meaningful) {
    const ok =
      isJsxElement(child as Node) && isComponentName((child as JsxElement).name)
        ? allowedNames.has((child as JsxElement).name!)
        : false;
    if (!ok) {
      issues.push(
        at(
          {
            severity: "error",
            rule: "children",
            message: `<${el.name}> may only contain: ${[...allowedNames].map((n) => `<${n}>`).join(", ")}`,
            component: el.name!,
          },
          (child as Node).position ?? el.position,
        ),
      );
    }
  }
}

/** Escape hatch used by callers that need the parent chain (placement checks). */
export function isParent(node: Node): node is Parent {
  return "children" in node && Array.isArray((node as Parent).children);
}
