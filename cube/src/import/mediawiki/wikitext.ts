/**
 * Balanced-brace wikitext utilities (pure functions, no MW expansion).
 *
 * parseCalls splits raw wikitext into literal runs and TOP-LEVEL template /
 * parser-function calls. Nested calls stay inside the enclosing param's raw
 * string; callers recurse by running parseCalls on a param value.
 */

import type { TemplateCall } from "./types";

/**
 * Normalize a template name the way MW does for the Template namespace:
 * strip "Template:" prefix, underscores/whitespace runs to single spaces,
 * first-letter uppercase. Parsoid's target.wt keeps a trailing "\n" on the
 * name (probe finding); the collapse+trim removes it.
 */
export function normalizeTemplateName(raw: string): string {
  let s = raw.replace(/[\s_]+/g, " ").trim();
  const prefix = /^template\s*:\s*/i.exec(s);
  if (prefix) s = s.slice(prefix[0].length);
  if (!s) return s;
  const first = String.fromCodePoint(s.codePointAt(0)!);
  const upper = first.toUpperCase();
  // Single-codepoint foldings only (MW ucfirst: "ß" stays "ß", not "SS").
  if ([...upper].length === 1) return upper + s.slice(first.length);
  return s;
}

/** Split a param value on a separator, trimming entries, dropping empties. */
export function splitList(value: string, sep: string): string[] {
  return value
    .split(sep)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

type Scanned = {
  /** null when the span is not a usable call (e.g. empty name "{{}}"). */
  call: TemplateCall | null;
  /** Index just past the closing "}}". */
  end: number;
};

function buildCall(segs: string[], eqs: number[]): TemplateCall | null {
  const head = segs[0] ?? "";
  const trimmedHead = head.trim();
  const params: Record<string, string> = {};
  let kind: "template" | "function";
  let name: string;
  let pos: number;

  if (trimmedHead.startsWith("#")) {
    kind = "function";
    const colon = head.indexOf(":");
    if (colon === -1) {
      name = trimmedHead.slice(1).trim().toLowerCase();
    } else {
      name = head.slice(0, colon).trim().slice(1).trim().toLowerCase();
      // Everything after the first ":" up to the first "|" is param "1",
      // kept raw (positional params are never trimmed: probe finding).
      params["1"] = head.slice(colon + 1);
    }
    pos = 2;
  } else {
    kind = "template";
    name = normalizeTemplateName(head);
    pos = 1;
  }
  if (!name) return null;

  for (let k = 1; k < segs.length; k++) {
    const seg = segs[k] ?? "";
    const eq = eqs[k] ?? -1;
    if (eq >= 0) {
      const key = seg.slice(0, eq).trim();
      if (key) {
        params[key] = seg.slice(eq + 1).trim();
        continue;
      }
    }
    params[String(pos++)] = seg;
  }
  return { kind, name, params };
}

/**
 * Scan one call starting at the "{{" at `start`. Depth is counted in raw
 * braces so runs like "{{{arg}}}" inside params balance without a stack.
 * Returns null when the outer call never closes (unbalanced input).
 */
function scanCall(src: string, start: number): Scanned | null {
  const n = src.length;
  let i = start + 2;
  let depth = 2;
  let linkDepth = 0;
  let seg = "";
  let segEq = -1;
  const segs: string[] = [];
  const eqs: number[] = [];
  const pushSeg = () => {
    segs.push(seg);
    eqs.push(segEq);
    seg = "";
    segEq = -1;
  };

  while (i < n) {
    const c = src[i];
    if (c === "{") {
      let r = 1;
      while (src[i + r] === "{") r++;
      if (r >= 2) {
        depth += r;
        seg += src.slice(i, i + r);
        i += r;
        continue;
      }
      seg += c;
      i++;
      continue;
    }
    if (c === "}") {
      let r = 1;
      while (src[i + r] === "}") r++;
      // Close nested braces first; they belong to the current param's raw.
      const inner = Math.min(r, depth - 2);
      if (inner > 0) {
        seg += "}".repeat(inner);
        depth -= inner;
        i += inner;
        r -= inner;
      }
      if (r >= 2 && depth === 2) {
        pushSeg();
        return { call: buildCall(segs, eqs), end: i + 2 };
      }
      if (r > 0) {
        seg += "}".repeat(r);
        i += r;
      }
      continue;
    }
    if (c === "[" && src[i + 1] === "[") {
      linkDepth++;
      seg += "[[";
      i += 2;
      continue;
    }
    if (c === "]" && src[i + 1] === "]" && linkDepth > 0) {
      linkDepth--;
      seg += "]]";
      i += 2;
      continue;
    }
    // Pipes and "=" only count at the call's own level, outside links.
    if (c === "|" && depth === 2 && linkDepth === 0) {
      pushSeg();
      i++;
      continue;
    }
    if (c === "=" && depth === 2 && linkDepth === 0 && segEq === -1 && segs.length > 0) {
      segEq = seg.length;
    }
    seg += c;
    i++;
  }
  return null;
}

/**
 * Split wikitext into literal text runs and top-level calls. Never throws:
 * unbalanced braces make the remainder literal text.
 */
export function parseCalls(wikitext: string): Array<string | TemplateCall> {
  const out: Array<string | TemplateCall> = [];
  const n = wikitext.length;
  let literal = "";
  let i = 0;
  const flush = () => {
    if (literal) {
      out.push(literal);
      literal = "";
    }
  };

  while (i < n) {
    if (wikitext[i] === "{" && wikitext[i + 1] === "{") {
      let run = 2;
      while (wikitext[i + run] === "{") run++;
      if (run >= 3) {
        // "{{{param}}}" is template-argument syntax, not a call; the span
        // passes through as literal. Extra braces beyond three stay literal
        // in front (MW prefers the argument reading).
        literal += wikitext.slice(i, i + run - 3);
        const open = i + run - 3;
        const close = wikitext.indexOf("}}}", open + 3);
        if (close === -1) {
          literal += wikitext.slice(open);
          break;
        }
        literal += wikitext.slice(open, close + 3);
        i = close + 3;
        continue;
      }
      const scanned = scanCall(wikitext, i);
      if (scanned === null) {
        literal += wikitext.slice(i);
        break;
      }
      if (scanned.call) {
        flush();
        out.push(scanned.call);
      } else {
        literal += wikitext.slice(i, scanned.end);
      }
      i = scanned.end;
      continue;
    }
    literal += wikitext[i];
    i++;
  }
  flush();
  return out;
}
