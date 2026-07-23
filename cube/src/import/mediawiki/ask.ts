/**
 * Semantic MediaWiki inline-query parsing for {{#ask:}} and {{#show:}}.
 *
 * Works on TemplateCall params as produced by parseCalls: param "1" is the
 * raw text after "#ask:", later pipe chunks are positional ("2", "3", ...)
 * unless they contained a top-level "=" (then they arrive named: this is
 * how "?Has game=Game" printouts show up, keyed "?Has game").
 */

import type { AskQuery, TemplateCall } from "./types";
import { splitList } from "./wikitext";

function printoutProperty(text: string): string {
  // "?Has photo#-": the "#..." suffix is an SMW output format, not part of
  // the property name.
  let p = text.trim().replace(/^\?/, "");
  const hash = p.indexOf("#");
  if (hash !== -1) p = p.slice(0, hash);
  return p.trim();
}

export function parseAsk(call: TemplateCall): AskQuery {
  const q: AskQuery = { conditions: "", printouts: [], extra: {} };
  const conditionParts: string[] = [];

  for (const [key, value] of Object.entries(call.params)) {
    if (/^\d+$/.test(key)) {
      const v = value.trim();
      if (key === "1" || v.startsWith("[[")) {
        if (v) conditionParts.push(v);
        continue;
      }
      if (v.startsWith("?")) {
        q.printouts.push({ property: printoutProperty(v) });
        continue;
      }
      q.extra[key] = v;
      continue;
    }
    if (key.startsWith("?")) {
      const printout: { property: string; label?: string } = {
        property: printoutProperty(key),
      };
      const label = value.trim();
      if (label) printout.label = label;
      q.printouts.push(printout);
      continue;
    }
    switch (key) {
      case "format":
        q.format = value.trim();
        break;
      case "limit": {
        const raw = value.trim();
        const num = Number(raw);
        if (raw && Number.isFinite(num)) q.limit = num;
        else q.extra[key] = value;
        break;
      }
      case "sort":
        q.sort = splitList(value, ",");
        break;
      case "order":
        q.order = splitList(value, ",");
        break;
      case "template":
        q.template = value.trim();
        break;
      case "mainlabel":
        q.mainlabel = value.trim();
        break;
      default:
        q.extra[key] = value;
    }
  }
  q.conditions = conditionParts.join("");
  return q;
}

export type ShowQuery = {
  page: string;
  printout?: string;
};

export function parseShow(call: TemplateCall): ShowQuery {
  const page = (call.params["1"] ?? "").trim();
  let printout: string | undefined;
  for (const [key, value] of Object.entries(call.params)) {
    if (/^\d+$/.test(key)) {
      if (key === "1") continue;
      const v = value.trim();
      if (v.startsWith("?")) {
        printout = printoutProperty(v);
        break;
      }
    } else if (key.startsWith("?")) {
      printout = printoutProperty(key);
      break;
    }
  }
  return { page, printout };
}

export type ParsedConditions = {
  articleTypes: string[];
  propertyEquals: { property: string; value: string }[];
  propertyExists: string[];
  /** Raw condition text the converter does not model (Category:, page
   * names, comparators, OR connectors between blocks, malformed input). */
  unsupported: string[];
};

export function parseConditions(conditions: string): ParsedConditions {
  const out: ParsedConditions = {
    articleTypes: [],
    propertyEquals: [],
    propertyExists: [],
    unsupported: [],
  };
  const pushUnsupported = (text: string) => {
    const t = text.trim();
    if (t) out.unsupported.push(t);
  };

  let i = 0;
  while (i < conditions.length) {
    const open = conditions.indexOf("[[", i);
    if (open === -1) {
      pushUnsupported(conditions.slice(i));
      break;
    }
    pushUnsupported(conditions.slice(i, open));
    const close = conditions.indexOf("]]", open + 2);
    if (close === -1) {
      pushUnsupported(conditions.slice(open));
      break;
    }
    const raw = conditions.slice(open, close + 2);
    const inner = conditions.slice(open + 2, close);
    i = close + 2;

    const sep = inner.indexOf("::");
    if (sep === -1) {
      // [[Category:X]] and plain page-name conditions land here.
      out.unsupported.push(raw);
      continue;
    }
    const property = inner.slice(0, sep).trim();
    const values = inner
      .slice(sep + 2)
      .split("||")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (!property || values.length === 0) {
      out.unsupported.push(raw);
      continue;
    }
    // Comparator values (>, <, !, ~, ...) are not equality; keep raw.
    if (values.some((v) => /^[<>!~≥≤]/.test(v))) {
      out.unsupported.push(raw);
      continue;
    }
    if (property.toLowerCase() === "has article type") {
      out.articleTypes.push(...values);
      continue;
    }
    for (const value of values) {
      if (value === "+") out.propertyExists.push(property);
      else out.propertyEquals.push({ property, value });
    }
  }
  return out;
}
