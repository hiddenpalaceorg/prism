/**
 * Visual editor round-trip tests: markdown -> parseDocument -> mdastToDoc ->
 * (headless TipTap editor) -> docToMarkdown -> parseDocument, asserting the
 * two mdast trees are identical modulo positions. Byte identity is NOT
 * required; AST identity IS.
 *
 * jsdom globals must be installed before any @tiptap import, so everything
 * that touches TipTap is imported dynamically below the setup.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

/* ---- jsdom globals (before importing @tiptap) ------------------------------- */

// jsdom ships no types and cube declares no @types/jsdom; type the small
// surface this test touches.
type MinimalDom = {
  window: Record<string, unknown> & { document: { createElement(tag: string): unknown } };
};
// @ts-expect-error -- no type declarations for jsdom; cast below covers usage
const jsdomModule = (await import("jsdom")) as unknown as {
  JSDOM: new (html: string, options?: object) => MinimalDom;
};
const { JSDOM } = jsdomModule;

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
for (const key of [
  "window",
  "document",
  "navigator",
  "DOMParser",
  "MutationObserver",
  "Range",
  "Node",
  "Element",
  "HTMLElement",
  "Text",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "ClipboardEvent",
  "InputEvent",
  "KeyboardEvent",
  "MouseEvent",
  "CustomEvent",
  "DragEvent",
]) {
  Object.defineProperty(globalThis, key, {
    value: dom.window[key],
    configurable: true,
    writable: true,
  });
}

const { parseDocument } = await import("../src/parse");
const { buildExtensions, docToMarkdown, markdownToDoc } = await import("../src/editor/index");
const { testRegistry } = await import("./helpers");
const { Editor, getSchema } = await import("@tiptap/core");
const extensions = buildExtensions(testRegistry);
const schema = getSchema(extensions);
const editor = new Editor({
  element: dom.window.document.createElement("div") as never,
  extensions,
});

/* ---- helpers ------------------------------------------------------------------ */

function stripPositions<T>(node: T): T {
  return JSON.parse(
    JSON.stringify(node, (key, value) => (key === "position" ? undefined : value)),
  ) as T;
}

/** markdown -> doc -> markdown, checking the doc against the editor schema. */
function roundTrip(markdown: string): string {
  const { doc, issues } = markdownToDoc(markdown, testRegistry);
  assert.deepEqual(issues, []);
  assert.ok(doc, "conversion produced a doc");
  schema.nodeFromJSON(doc).check();
  return docToMarkdown(doc, testRegistry);
}

function assertAstIdentity(markdown: string): string {
  const out = roundTrip(markdown);
  const before = parseDocument(markdown);
  const after = parseDocument(out);
  assert.ok(before.root, "original parses");
  assert.ok(after.root, `round-tripped output parses: ${JSON.stringify(out)}`);
  assert.deepEqual(stripPositions(after.root), stripPositions(before.root));
  return out;
}

/* ---- round-trip corpus ----------------------------------------------------------- */

const corpus: Record<string, string> = {
  "heading, prose, bold, code": [
    "# Sonic 2 Beta",
    "",
    "Some *emphasis*, **bold text**, ~~struck~~, and `inline code`.",
    "",
    "```js",
    "const x = 1;",
    "```",
  ].join("\n"),
  "prototype tag with mixed attr types":
    '<Prototype game="Sonic the Hedgehog 2" system="Genesis" buildDate="1992-09-14" ' +
    'sortNumber={5} dumpedBy={["drx","Hidden Palace"]} unreleased={true} />',
  "filelist with fileentry children": [
    "<FileList>",
    '<FileEntry filename="a.bin" size={128} sha1="da39a3ee5e6b" />',
    '<FileEntry filename="b.bin" />',
    "</FileList>",
  ].join("\n"),
  "hexdump with fenced json child": [
    "<HexDump>",
    "",
    "```json",
    "{",
    ' "offset": 16,',
    ' "bytes": [1, 2, 3]',
    "}",
    "```",
    "",
    "</HexDump>",
  ].join("\n"),
  "wiki links": "See [[Sonic the Hedgehog 2]] and [[Sonic 2|the beta]] and [[Sonic 2 (beta)|]].",
  "gfm table": [
    "| Region | Date |",
    "| --- | --- |",
    "| US | 1992 |",
    "| JP | 1993 |",
  ].join("\n"),
  "gfm table with alignment": [
    "| Name | Size |",
    "| :-- | --: |",
    "| a.bin | 128 |",
  ].join("\n"),
  "unknown component": '<NotRegistered foo="1" bar={2} />',
  "raw html block": '<div class="x">legacy html</div>',
  "inline lowercase tag": "text with <br /> inline",
  "inline component in prose": 'Released <RegionDate region="US" date="1992-11-24" /> in stores.',
  "inline component at flow level": '<RegionDate region="JP" date="1992-11-21" />',
  "blockquote and lists": [
    "> a quoted line",
    "",
    "- one",
    "- two with **bold**",
    "- three",
    "",
    "1. first",
    "2. second",
  ].join("\n"),
  "links, images, breaks": [
    "A [link](https://example.org) and an ![shot](media:Title.png) image.",
    "",
    "---",
  ].join("\n"),
  "nested marks": "**bold with *italic inside* and `code`** and *[[Page|styled link]]*.",
  "component with markdown-ish attrs": '<GameNav game="Sonic the Hedgehog 2" />',
};

for (const [name, markdown] of Object.entries(corpus)) {
  test(`round-trip AST identity: ${name}`, () => {
    assertAstIdentity(markdown);
  });
}

test("round-trip AST identity: full composite page", () => {
  const page = [
    corpus["prototype tag with mixed attr types"],
    corpus["heading, prose, bold, code"],
    corpus["wiki links"],
    corpus["filelist with fileentry children"],
    corpus["hexdump with fenced json child"],
    corpus["gfm table"],
    corpus["unknown component"],
    corpus["blockquote and lists"],
  ].join("\n\n");
  assertAstIdentity(page);
});

/* ---- safety valves ------------------------------------------------------------------ */

test("unknown components survive untouched", () => {
  const src = 'before\n\n<NotRegistered foo="1" bar={2}>\nkept *verbatim*\n</NotRegistered>\n\nafter';
  const out = assertAstIdentity(src);
  assert.ok(out.includes('<NotRegistered foo="1" bar={2}>'), "open tag text preserved");
  assert.ok(out.includes("kept *verbatim*"), "children preserved");
});

test("registered component with unknown attr degrades to cubeUnknown, raw preserved", () => {
  const src = '<Prototype game="Sonic 2" bogus="nope" />';
  const { doc } = markdownToDoc(src, testRegistry);
  assert.ok(doc);
  assert.equal(doc.content[0]!.type, "cubeUnknown");
  const out = assertAstIdentity(src);
  assert.ok(out.includes(src));
});

test("unparseable attr expression degrades to cubeUnknown, raw preserved", () => {
  const src = "<Prototype game={not_json} />";
  const { doc } = markdownToDoc(src, testRegistry);
  assert.ok(doc);
  assert.equal(doc.content[0]!.type, "cubeUnknown");
  assertAstIdentity(src);
});

test("children:json survives a round trip intact", () => {
  const src = corpus["hexdump with fenced json child"]!;
  const out = assertAstIdentity(src);
  const { root } = parseDocument(out);
  assert.ok(root);
  const el = root.children.find((n) => n.type === "mdxJsxFlowElement");
  assert.ok(el && el.type === "mdxJsxFlowElement" && el.name === "HexDump");
  const code = el.children[0];
  assert.ok(code && code.type === "code" && code.lang === "json");
  assert.deepEqual(JSON.parse(code.value), { offset: 16, bytes: [1, 2, 3] });
});

test("task lists and fence meta fall back to raw blocks verbatim", () => {
  for (const src of ["- [x] done\n- [ ] todo", '```js title="x.js"\nlet a;\n```']) {
    const { doc } = markdownToDoc(src, testRegistry);
    assert.ok(doc);
    assert.equal(doc.content[0]!.type, "cubeRawBlock");
    assert.equal(doc.content[0]!.attrs!.raw, src);
    assertAstIdentity(src);
  }
});

test("wiki link pipe trick label is preserved", () => {
  const out = assertAstIdentity("[[Sonic 2 (beta)|]]");
  assert.ok(out.includes("[[Sonic 2 (beta)|]]"));
});

/* ---- conversion shape checks ---------------------------------------------------------- */

test("component attrs land on the node; json children land in __children", () => {
  const { doc } = markdownToDoc(corpus["prototype tag with mixed attr types"]!, testRegistry);
  assert.ok(doc);
  const node = doc.content[0]!;
  assert.equal(node.type, "cube_Prototype");
  assert.equal(node.attrs!.game, "Sonic the Hedgehog 2");
  assert.equal(node.attrs!.sortNumber, 5);
  assert.deepEqual(node.attrs!.dumpedBy, ["drx", "Hidden Palace"]);
  assert.equal(node.attrs!.unreleased, true);
  assert.equal(node.attrs!.originLot, null);

  const { doc: hex } = markdownToDoc(corpus["hexdump with fenced json child"]!, testRegistry);
  assert.ok(hex);
  assert.equal(hex.content[0]!.type, "cube_HexDump");
  assert.deepEqual(JSON.parse(hex.content[0]!.attrs!.__children as string), {
    offset: 16,
    bytes: [1, 2, 3],
  });
  assert.equal(hex.content[0]!.content, undefined);
});

test("empty markdown yields an editable empty doc that serializes to empty", () => {
  const { doc } = markdownToDoc("", testRegistry);
  assert.ok(doc);
  schema.nodeFromJSON(doc).check();
  assert.equal(docToMarkdown(doc, testRegistry), "");
});

/* ---- headless editor ------------------------------------------------------------------- */

test("headless TipTap editor accepts converted docs and round-trips them", () => {
  const page = [
    corpus["prototype tag with mixed attr types"],
    corpus["heading, prose, bold, code"],
    corpus["filelist with fileentry children"],
    corpus["hexdump with fenced json child"],
    corpus["wiki links"],
    corpus["gfm table with alignment"],
    corpus["unknown component"],
  ].join("\n\n");
  const { doc } = markdownToDoc(page, testRegistry);
  assert.ok(doc);
  editor.commands.setContent(doc);
  const out = docToMarkdown(editor.getJSON() as never, testRegistry);
  const before = parseDocument(page);
  const after = parseDocument(out);
  assert.ok(before.root && after.root);
  assert.deepEqual(stripPositions(after.root), stripPositions(before.root));
});

test("editing through the editor produces valid markdown", () => {
  const { doc } = markdownToDoc("Hello world.", testRegistry);
  assert.ok(doc);
  editor.commands.setContent(doc);
  editor.commands.selectAll();
  editor.commands.setBold();
  const out = docToMarkdown(editor.getJSON() as never, testRegistry);
  assert.equal(out.trim(), "**Hello world.**");
});
