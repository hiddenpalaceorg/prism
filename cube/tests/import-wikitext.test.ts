import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCalls, normalizeTemplateName, splitList } from "../src/import/mediawiki/wikitext";
import { parseAsk, parseShow, parseConditions } from "../src/import/mediawiki/ask";
import { parseFuzzyDate } from "../src/import/mediawiki/dates";
import type { TemplateCall } from "../src/import/mediawiki/types";

function calls(wikitext: string): TemplateCall[] {
  return parseCalls(wikitext).filter((p): p is TemplateCall => typeof p !== "string");
}

function onlyCall(wikitext: string): TemplateCall {
  const cs = calls(wikitext);
  assert.equal(cs.length, 1, `expected one call in ${JSON.stringify(wikitext)}`);
  return cs[0]!;
}

// ---------------------------------------------------------------- parseCalls

test("plain text yields a single literal run", () => {
  assert.deepEqual(parseCalls("just some text"), ["just some text"]);
  assert.deepEqual(parseCalls(""), []);
});

test("positional and named params", () => {
  assert.deepEqual(onlyCall("{{Name|a|b=c}}"), {
    kind: "template",
    name: "Name",
    params: { "1": "a", b: "c" },
  });
});

test("literal runs around a call are preserved", () => {
  const parts = parseCalls("before {{Foo}} after");
  assert.deepEqual(parts, [
    "before ",
    { kind: "template", name: "Foo", params: {} },
    " after",
  ]);
});

test("named param splits on the FIRST = only", () => {
  assert.deepEqual(onlyCall("{{T|a=b=c}}").params, { a: "b=c" });
});

test("positional params keep raw whitespace, named params are trimmed", () => {
  const call = onlyCall("{{T| a | b = c }}");
  assert.deepEqual(call.params, { "1": " a ", b: "c" });
});

test("nested call stays inside the parent param as raw text", () => {
  const call = onlyCall("{{a|{{b|c}}}}");
  assert.equal(call.name, "A");
  assert.deepEqual(call.params, { "1": "{{b|c}}" });
});

test("nested RegionDate inside a named param", () => {
  const call = onlyCall("{{Infobox|released={{RegionDate|JP|Nov 21, 1992}}|status=Released}}");
  assert.equal(call.params["released"], "{{RegionDate|JP|Nov 21, 1992}}");
  assert.equal(call.params["status"], "Released");
  // Recursing into the param value yields the nested call with its params.
  const nested = onlyCall(call.params["released"]!);
  assert.deepEqual(nested, {
    kind: "template",
    name: "RegionDate",
    params: { "1": "JP", "2": "Nov 21, 1992" },
  });
});

test("filelist-style call: many nested entries stay raw, recursion finds them", () => {
  const wt =
    "{{filelist|\n" +
    "{{filelistentry|file=a.bin|size=1}}\n" +
    "{{filelistentry|file=b.bin|size=2}}\n" +
    "{{filelistentry|file=c.bin|size=3}}\n" +
    "}}";
  const outer = onlyCall(wt);
  assert.equal(outer.name, "Filelist");
  assert.equal(Object.keys(outer.params).length, 1);
  const body = outer.params["1"]!;
  assert.ok(body.includes("{{filelistentry|file=a.bin|size=1}}"));
  const entries = calls(body);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((c) => c.name), ["Filelistentry", "Filelistentry", "Filelistentry"]);
  assert.deepEqual(entries[1]!.params, { file: "b.bin", size: "2" });
  // The literal runs between entries survive as text.
  const literals = parseCalls(body).filter((p) => typeof p === "string");
  assert.deepEqual(literals, ["\n", "\n", "\n", "\n"]);
});

test("pipes inside [[links]] do not split params", () => {
  const call = onlyCall("{{T|[[a|b]]|x}}");
  assert.deepEqual(call.params, { "1": "[[a|b]]", "2": "x" });
});

test("= inside nested braces or links does not make a param named", () => {
  assert.deepEqual(onlyCall("{{T|{{U|k=v}}}}").params, { "1": "{{U|k=v}}" });
  assert.deepEqual(onlyCall("{{T|[[File:x.png|alt=y]]}}").params, { "1": "[[File:x.png|alt=y]]" });
});

test("triple-brace {{{param}}} passes through as literal text", () => {
  assert.deepEqual(parseCalls("{{{param}}}"), ["{{{param}}}"]);
  const parts = parseCalls("x {{{1}}} y {{Tpl}}");
  assert.deepEqual(parts, [
    "x {{{1}}} y ",
    { kind: "template", name: "Tpl", params: {} },
  ]);
});

test("magic word with no args is a template call", () => {
  assert.deepEqual(onlyCall("{{PAGENAME}}"), {
    kind: "template",
    name: "PAGENAME",
    params: {},
  });
});

test("parser function: #ask lowercased without #, colon starts param 1", () => {
  const call = onlyCall("{{#ask: [[Has article type::Video]] |?Has game=Game |format=table}}");
  assert.equal(call.kind, "function");
  assert.equal(call.name, "ask");
  assert.equal(call.params["1"], " [[Has article type::Video]] ");
  assert.equal(call.params["?Has game"], "Game");
  assert.equal(call.params["format"], "table");
});

test("parser function params continue 2, 3, ... after the colon chunk", () => {
  const call = onlyCall("{{#switch: x | a | b=c}}");
  assert.equal(call.name, "switch");
  assert.deepEqual(call.params, { "1": " x ", "2": " a ", b: "c" });
});

test("Template: prefix, underscores, and trailing newline normalize", () => {
  assert.equal(onlyCall("{{Template:foo_bar|x}}").name, "Foo bar");
  assert.equal(onlyCall("{{Foo\n|x}}").name, "Foo");
});

test("unbalanced braces never throw; remainder becomes literal text", () => {
  assert.deepEqual(parseCalls("{{foo|bar"), ["{{foo|bar"]);
  assert.deepEqual(parseCalls("text {{a}} {{unclosed"), [
    "text ",
    { kind: "template", name: "A", params: {} },
    " {{unclosed",
  ]);
  // Nested call opened but outer never closed.
  assert.deepEqual(parseCalls("{{a|{{b}}"), ["{{a|{{b}}"]);
  // Stray closers are plain text.
  assert.deepEqual(parseCalls("}} loose }}"), ["}} loose }}"]);
});

test("empty or nameless braces stay literal", () => {
  assert.deepEqual(parseCalls("{{}}"), ["{{}}"]);
  assert.deepEqual(parseCalls("a {{}} b"), ["a {{}} b"]);
});

// ------------------------------------------------- normalizeTemplateName

test("normalizeTemplateName", () => {
  assert.equal(normalizeTemplateName("Template:foo"), "Foo");
  assert.equal(normalizeTemplateName("template:_foo__bar_"), "Foo bar");
  assert.equal(normalizeTemplateName("  foo   bar  "), "Foo bar");
  assert.equal(normalizeTemplateName("Foo\n"), "Foo");
  assert.equal(normalizeTemplateName("über tpl"), "Über tpl");
  // ß uppercases to SS (multi-codepoint): left alone, matching MW ucfirst.
  assert.equal(normalizeTemplateName("ßeta"), "ßeta");
  assert.equal(normalizeTemplateName("PAGENAME"), "PAGENAME");
  assert.equal(normalizeTemplateName(""), "");
});

// ----------------------------------------------------------------- splitList

test("splitList trims entries and drops empties", () => {
  assert.deepEqual(splitList("a, b,,c ", ","), ["a", "b", "c"]);
  assert.deepEqual(splitList("Sonic 2; Sonic 3;", ";"), ["Sonic 2", "Sonic 3"]);
  assert.deepEqual(splitList("", ","), []);
  assert.deepEqual(splitList("  ", ","), []);
});

// ------------------------------------------------------------------ parseAsk

test("parseAsk: conditions, printouts, format=template, limit", () => {
  const call = onlyCall(
    "{{#ask: [[Has article type::Video]] [[Has origin lot::Altron lot]]" +
      " |?Has game=Game |?Has photo#- |format=template |template=Row" +
      " |limit=20 |sort=Has date, Has game |order=asc, desc |mainlabel=- |intro=hi}}",
  );
  const q = parseAsk(call);
  assert.equal(q.conditions, "[[Has article type::Video]] [[Has origin lot::Altron lot]]");
  // Positional printouts ("?Has photo#-" had no "=") iterate before named
  // ones: JS orders integer-like keys first in Record params.
  assert.deepEqual(q.printouts, [
    { property: "Has photo" },
    { property: "Has game", label: "Game" },
  ]);
  assert.equal(q.format, "template");
  assert.equal(q.template, "Row");
  assert.equal(q.limit, 20);
  assert.deepEqual(q.sort, ["Has date", "Has game"]);
  assert.deepEqual(q.order, ["asc", "desc"]);
  assert.equal(q.mainlabel, "-");
  assert.deepEqual(q.extra, { intro: "hi" });
});

test("parseAsk: later positional [[...]] params concatenate into conditions", () => {
  const q = parseAsk(onlyCall("{{#ask: [[Category:Games]] | [[Has platform::PS2]] |format=count}}"));
  assert.equal(q.conditions, "[[Category:Games]][[Has platform::PS2]]");
  assert.equal(q.format, "count");
  assert.deepEqual(q.printouts, []);
});

test("parseAsk: non-numeric limit goes to extra", () => {
  const q = parseAsk(onlyCall("{{#ask: [[A::B]] |limit=lots}}"));
  assert.equal(q.limit, undefined);
  assert.equal(q.extra["limit"], "lots");
});

test("parseAsk: printout without label from a named ?param with empty value", () => {
  const q = parseAsk(onlyCall("{{#ask: [[A::B]] |?Has game=}}"));
  assert.deepEqual(q.printouts, [{ property: "Has game" }]);
});

// ----------------------------------------------------------------- parseShow

test("parseShow: page and first ?printout", () => {
  const s = parseShow(onlyCall("{{#show: Sonic 2 | ?Has release date}}"));
  assert.deepEqual(s, { page: "Sonic 2", printout: "Has release date" });
});

test("parseShow: named ?printout with output format suffix", () => {
  const s = parseShow(onlyCall("{{#show: Page | ?Has date#ISO=D}}"));
  assert.deepEqual(s, { page: "Page", printout: "Has date" });
});

test("parseShow: no printout", () => {
  const s = parseShow(onlyCall("{{#show: Page}}"));
  assert.deepEqual(s, { page: "Page", printout: undefined });
});

// ----------------------------------------------------------- parseConditions

test("parseConditions: article type, OR-lists, equals, exists", () => {
  const r = parseConditions(
    "[[Has article type::Disc type||Board||Dev kit]]" +
      "[[Has origin lot::Altron lot]][[Has hardware id::+]]",
  );
  assert.deepEqual(r.articleTypes, ["Disc type", "Board", "Dev kit"]);
  assert.deepEqual(r.propertyEquals, [{ property: "Has origin lot", value: "Altron lot" }]);
  assert.deepEqual(r.propertyExists, ["Has hardware id"]);
  assert.deepEqual(r.unsupported, []);
});

test("parseConditions: single article type", () => {
  const r = parseConditions("[[Has article type::Video]]");
  assert.deepEqual(r.articleTypes, ["Video"]);
});

test("parseConditions: Category, page names, and comparators are unsupported", () => {
  const r = parseConditions("[[Category:Lot articles]][[Sonic 2]][[Has date::>1992]]");
  assert.deepEqual(r.articleTypes, []);
  assert.deepEqual(r.propertyEquals, []);
  assert.deepEqual(r.unsupported, [
    "[[Category:Lot articles]]",
    "[[Sonic 2]]",
    "[[Has date::>1992]]",
  ]);
});

test("parseConditions: stray text between blocks is unsupported, whitespace is not", () => {
  const r = parseConditions("[[A::B]] OR [[C::D]]");
  assert.deepEqual(r.propertyEquals, [
    { property: "A", value: "B" },
    { property: "C", value: "D" },
  ]);
  assert.deepEqual(r.unsupported, ["OR"]);
  const clean = parseConditions("[[A::B]]\n[[C::+]]");
  assert.deepEqual(clean.unsupported, []);
  assert.deepEqual(clean.propertyExists, ["C"]);
});

test("parseConditions: malformed input never throws", () => {
  const r = parseConditions("[[Broken");
  assert.deepEqual(r.unsupported, ["[[Broken"]);
  assert.deepEqual(parseConditions("").unsupported, []);
});

// -------------------------------------------------------------- parseFuzzyDate

test("parseFuzzyDate: year only", () => {
  assert.equal(parseFuzzyDate("1992"), "1992");
  assert.equal(parseFuzzyDate("  1992  "), "1992");
});

test("parseFuzzyDate: year-month", () => {
  assert.equal(parseFuzzyDate("May 1992"), "1992-05");
  assert.equal(parseFuzzyDate("may 1992"), "1992-05");
  assert.equal(parseFuzzyDate("SEPTEMBER 1992"), "1992-09");
  assert.equal(parseFuzzyDate("1992-05"), "1992-05");
  assert.equal(parseFuzzyDate("1992-5"), "1992-05");
});

test("parseFuzzyDate: full dates in every listed shape", () => {
  assert.equal(parseFuzzyDate("Sep 29, 1992"), "1992-09-29");
  assert.equal(parseFuzzyDate("September 29, 1992"), "1992-09-29");
  assert.equal(parseFuzzyDate("29 Sep 1992"), "1992-09-29");
  assert.equal(parseFuzzyDate("1992-09-29"), "1992-09-29");
  assert.equal(parseFuzzyDate("sep 29 1992"), "1992-09-29");
  assert.equal(parseFuzzyDate("Sept 29, 1992"), "1992-09-29");
  assert.equal(parseFuzzyDate("Nov 21, 1992"), "1992-11-21");
  assert.equal(parseFuzzyDate("29 September 1992"), "1992-09-29");
});

test("parseFuzzyDate: trailing time of day is stripped", () => {
  assert.equal(parseFuzzyDate("Sep 29, 1992 10:33:00"), "1992-09-29");
  assert.equal(parseFuzzyDate("Sep 29, 1992 10:33"), "1992-09-29");
  assert.equal(parseFuzzyDate("1992-09-29 10:33:00"), "1992-09-29");
  assert.equal(parseFuzzyDate("  Sep 29, 1992 10:33:00  "), "1992-09-29");
});

test("parseFuzzyDate: impossible calendar dates rejected", () => {
  assert.equal(parseFuzzyDate("Feb 30, 1999"), null);
  assert.equal(parseFuzzyDate("Feb 29, 1992"), "1992-02-29");
  assert.equal(parseFuzzyDate("Feb 29, 1991"), null);
  assert.equal(parseFuzzyDate("1900-02-29"), null);
  assert.equal(parseFuzzyDate("2000-02-29"), "2000-02-29");
  assert.equal(parseFuzzyDate("1992-13"), null);
  assert.equal(parseFuzzyDate("1992-00-10"), null);
  assert.equal(parseFuzzyDate("1992-09-31"), null);
});

test("parseFuzzyDate: garbage is null", () => {
  assert.equal(parseFuzzyDate(""), null);
  assert.equal(parseFuzzyDate("   "), null);
  assert.equal(parseFuzzyDate("hello"), null);
  assert.equal(parseFuzzyDate("circa 1992"), null);
  assert.equal(parseFuzzyDate("Mai 29, 1992"), null);
  assert.equal(parseFuzzyDate("29-09-1992"), null);
});
