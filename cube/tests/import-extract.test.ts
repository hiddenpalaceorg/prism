import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  extractHtml,
  type ExtractedTransclusion,
  type ExtractHtmlResult,
} from "../src/import/mediawiki/extract-html";
import type { TemplateCall } from "../src/import/mediawiki/types";

const FIXTURES = new URL("../spikes/fixtures/parsoid/", import.meta.url);
const HAVE_FIXTURES = existsSync(FIXTURES);

function loadFixtureHtml(name: string): string {
  const raw = readFileSync(new URL(`${name}.json`, FIXTURES), "utf8");
  return (JSON.parse(raw) as { html: string }).html;
}

function templateCalls(t: ExtractedTransclusion): TemplateCall[] {
  return t.calls.filter((c): c is TemplateCall => typeof c !== "string");
}

function findByName(
  result: ExtractHtmlResult,
  name: string,
): ExtractedTransclusion | undefined {
  return result.transclusions.find((t) =>
    templateCalls(t).some((c) => c.name === name),
  );
}

test("sonic fixture: transclusions, extensions, categories", { skip: !HAVE_FIXTURES && "parsoid fixtures not present" }, () => {
  const result = extractHtml(loadFixtureHtml("sonic2_nick_arcade"));

  // Prototype, Download, Tcrf link, filelist, Prototype Footer.
  assert.equal(result.transclusions.length, 5);

  const proto = findByName(result, "Prototype");
  assert.ok(proto, "Prototype transclusion present");
  const protoCall = templateCalls(proto)[0]!;
  assert.equal(protoCall.kind, "template");
  assert.equal(protoCall.params["game"], "Sonic the Hedgehog 2");
  assert.equal(protoCall.params["builddate"], "1992");
  // Nested calls stay opaque wikitext inside the param value.
  assert.ok(protoCall.params["release_date"]!.includes("{{RegionDate|JP|"));
  // Infobox about-group spans two top-level nodes (table + trailing <a>).
  assert.equal(proto.nodes.length, 2);
  assert.equal(proto.nodes[0]!.tagName, "table");
  assert.equal(proto.inline, false);
  assert.ok(proto.aboutId?.startsWith("#mwt"));

  const download = findByName(result, "Download");
  assert.ok(download, "Download transclusion present");
  const downloadCall = templateCalls(download)[0]!;
  assert.ok(downloadCall.params["file"]);
  assert.equal(downloadCall.params["title"], "{{PAGENAME}}");

  const filelist = findByName(result, "filelist");
  assert.ok(filelist, "filelist transclusion present");
  const filelistCall = templateCalls(filelist)[0]!;
  // filelistentry calls arrive unexpanded inside positional param 1.
  assert.ok(filelistCall.params["1"]!.includes("{{filelistentry"));
  // Positional params are not trimmed (leading newlines preserved).
  assert.ok(filelistCall.params["1"]!.startsWith("\n\n"));

  const footer = findByName(result, "Prototype Footer");
  assert.ok(footer, "Prototype Footer transclusion present");
  assert.equal(footer.inline, true); // first node is a <span>

  // Two galleries as extensions, never doubled as transclusions.
  const galleries = result.extensions.filter((e) => e.kind === "gallery");
  assert.equal(galleries.length, 2);
  for (const g of galleries) {
    assert.ok(g.extsrc, "gallery extsrc present");
    assert.equal(g.node.tagName, "ul");
  }
  assert.ok(galleries[0]!.extsrc!.includes("S2NA_Title.png|Title screen"));

  assert.ok(result.categories.length > 0);
  assert.ok(result.categories.includes("Sonic the Hedgehog 2 prototypes"));
  assert.ok(result.categories.includes("Sega Mega Drive prototypes"));

  // Node refs are shared with the returned root.
  assert.equal(result.root.type, "root");
});

test("videos_list fixture: single #ask parser-function call", { skip: !HAVE_FIXTURES && "parsoid fixtures not present" }, () => {
  const result = extractHtml(loadFixtureHtml("videos_list"));

  assert.equal(result.transclusions.length, 1);
  const calls = templateCalls(result.transclusions[0]!);
  assert.equal(calls.length, 1);
  const ask = calls[0]!;
  assert.equal(ask.kind, "function");
  assert.equal(ask.name, "ask");
  // First argument recovered from target.wt after "#ask:".
  assert.ok(ask.params["1"]!.includes("[[Has article type::Video]]"));
  // SMW printout selectors arrive as param names; named params keep keys.
  assert.equal(ask.params["?Has game"], "Game");
  assert.equal(ask.params["?Has video date"], "Date");
  assert.equal(ask.params["limit"], "3000");
});

test("prototypes_by_lot fixture: mixed string + template parts", { skip: !HAVE_FIXTURES && "parsoid fixtures not present" }, () => {
  const result = extractHtml(loadFixtureHtml("prototypes_by_lot"));

  assert.equal(result.transclusions.length, 1);
  const t = result.transclusions[0]!;
  assert.equal(t.calls.length, 2);

  // Hand-written table header row absorbed as a literal string part.
  const literal = t.calls[0]!;
  assert.equal(typeof literal, "string");
  assert.ok((literal as string).startsWith("|-\n! Lot"));

  const ask = t.calls[1]! as TemplateCall;
  assert.notEqual(typeof ask, "string");
  assert.equal(ask.kind, "function");
  assert.equal(ask.name, "ask");
  assert.ok(ask.params["1"]!.includes("[[Has article type::Lot]]"));
  // Parsoid's bare positional "1" ("?#-") is source argument 2: shifted.
  assert.equal(ask.params["2"], "?#-\n");
  assert.equal(ask.params["format"], "template");
  assert.equal(ask.params["template"], "Lot item");

  // All 44 result <tr>s belong to the about-group; first carries data-mw.
  assert.equal(t.nodes.length, 44);
  assert.ok(t.nodes.every((n) => n.tagName === "tr"));
  assert.equal(t.inline, false);
});

test("board fixture: duplicate section/table annotation dedupes to one", { skip: !HAVE_FIXTURES && "parsoid fixtures not present" }, () => {
  const result = extractHtml(loadFixtureHtml("171-5694-01"));

  // {{Board}} is annotated on both the <section> wrapper (#mwt2) and the
  // inner <table> (#mwt1) with identical parts; only the outermost survives.
  assert.equal(result.transclusions.length, 1);
  const board = result.transclusions[0]!;
  const calls = templateCalls(board);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "Board");
  assert.equal(calls[0]!.kind, "template");
  assert.equal(calls[0]!.params["hardware_id"], "171-5694-01");
  assert.equal(calls[0]!.params["system"], "Sega Mega Drive");

  // The kept entry is the outer section-level group (two <section> nodes),
  // not the nested table annotation.
  assert.equal(board.nodes[0]!.tagName, "section");
  assert.equal(board.nodes.length, 2);
  assert.equal(board.inline, false);
});
