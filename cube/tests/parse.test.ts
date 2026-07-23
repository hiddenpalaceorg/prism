import assert from "node:assert/strict";
import { test } from "node:test";
import type { Parent } from "mdast";
import { parseDocument, type WikiLink } from "../src/parse";
import { parseComponentTag, serializeComponentTag } from "../src/tags";
import { Prototype } from "./helpers";

function collect(root: Parent, type: string): unknown[] {
  const out: unknown[] = [];
  const walk = (n: unknown) => {
    const node = n as { type: string; children?: unknown[] };
    if (node.type === type) out.push(node);
    node.children?.forEach(walk);
  };
  walk(root);
  return out;
}

test("plain markdown parses", () => {
  const { root, issues } = parseDocument("# Title\n\nSome **bold** text.\n");
  assert.equal(issues.length, 0);
  assert.ok(root);
  assert.equal(root!.children[0]!.type, "heading");
});

test("component tags parse as mdx jsx nodes without evaluation", () => {
  const { root, issues } = parseDocument(
    `<Prototype game="Sonic 2" sortNumber={1} dumpedBy={["drx"]} />\n\nBody text.\n`,
  );
  assert.equal(issues.length, 0);
  const els = collect(root!, "mdxJsxFlowElement") as { name: string }[];
  assert.equal(els.length, 1);
  assert.equal(els[0]!.name, "Prototype");
});

test("literal braces in prose stay text (no expression syntax)", () => {
  const { root, issues } = parseDocument("The header field {origin} is set.\n");
  assert.equal(issues.length, 0);
  const text = collect(root!, "text") as { value: string }[];
  assert.ok(text.some((t) => t.value.includes("{origin}")));
});

test("gfm tables parse", () => {
  const { root } = parseDocument("| a | b |\n| - | - |\n| 1 | 2 |\n");
  assert.equal(collect(root!, "table").length, 1);
});

test("parse errors surface as line-accurate issues, not throws", () => {
  const { root, issues } = parseDocument("ok\n\n<Broken attr=\n");
  assert.equal(root, null);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.severity, "error");
  // The tokenizer reports at the point it gave up (line 3 or the EOF line).
  assert.ok(issues[0]!.line! >= 3);
});

test("html comments are a parse error with an actionable message", () => {
  const { root, issues } = parseDocument("text\n\n<!-- hidden note -->\n");
  assert.equal(root, null);
  assert.match(issues[0]!.message, /HTML comments/);
  assert.equal(issues[0]!.line, 3);
});

test("wiki links split out of text with positions", () => {
  const { root } = parseDocument("See [[Sonic the Hedgehog 2]] and [[171-5694-01|the board]].\n");
  const links = collect(root!, "wikiLink") as WikiLink[];
  assert.equal(links.length, 2);
  assert.equal(links[0]!.target, "Sonic the Hedgehog 2");
  assert.equal(links[0]!.label, undefined);
  assert.equal(links[1]!.target, "171-5694-01");
  assert.equal(links[1]!.label, "the board");
  assert.equal(links[0]!.position!.start.line, 1);
  assert.equal(links[0]!.position!.start.column, 5);
});

test("wiki links do not fire inside code", () => {
  const { root } = parseDocument("`[[not a link]]`\n\n```\n[[also not]]\n```\n");
  assert.equal(collect(root!, "wikiLink").length, 0);
});

test("tag codec: canonical serialization ordered by schema", () => {
  const s = serializeComponentTag(
    "Prototype",
    { sortNumber: 1, game: "Sonic 2", dumpedBy: ["drx", "x"], unreleased: false },
    Prototype,
  );
  assert.equal(s, `<Prototype game="Sonic 2" sortNumber={1} dumpedBy={["drx","x"]} unreleased={false} />`);
});

test("tag codec: strings needing escapes go to JSON braces", () => {
  const s = serializeComponentTag("X", { a: 'say "hi"', b: "multi\nline" });
  assert.equal(s, `<X a={"say \\"hi\\""} b={"multi\\nline"} />`);
});

test("tag codec: parse round-trip", () => {
  const attrs = { game: "Sonic 2", sortNumber: 1, dumpedBy: ["drx"], unreleased: true };
  const s = serializeComponentTag("Prototype", attrs, Prototype);
  const parsed = parseComponentTag(s);
  assert.ok(!("error" in parsed), JSON.stringify(parsed));
  if (!("error" in parsed)) {
    assert.equal(parsed.name, "Prototype");
    assert.deepEqual(parsed.attrs, attrs);
    assert.equal(parsed.hasChildren, false);
  }
});

test("tag codec: children serialization", () => {
  const s = serializeComponentTag("FileList", {}, undefined, { children: "content" });
  assert.equal(s, "<FileList>\ncontent\n</FileList>");
});

test("tag codec: rejects non-JSON expressions", () => {
  const parsed = parseComponentTag(`<X a={1 + 2} />`);
  assert.ok("error" in parsed);
});

test("inline component in paragraph parses via parseComponentTag", () => {
  const parsed = parseComponentTag(`<RegionDate region="JP" date="Nov 21, 1992" />`);
  assert.ok(!("error" in parsed));
});
