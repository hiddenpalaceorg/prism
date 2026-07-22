/**
 * End-to-end converter test: real Parsoid fixtures -> markdown -> cube's own
 * parser + validator with the real HP component registry. Offline (fixtures
 * from spikes/fixtures/parsoid, captured from the live wiki).
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { convert } from "../src/import/mediawiki/index";
import { parseDocument } from "../src/parse";
import { validateDocument } from "../src/validate";
import { checkQueries } from "../src/query-component";
import { createRegistry } from "../src/schema/index";
import { builtinComponents } from "../src/builtins";
import { hasErrors } from "../src/issues";
import { hpComponents } from "../../web/src/cube/schemas";
import { hpMapping, mapAsk } from "../../web/src/cube/mapping";

const FIXTURES = new URL("../spikes/fixtures/parsoid/", import.meta.url);
const HAVE_FIXTURES = existsSync(FIXTURES);
const registry = createRegistry([...builtinComponents, ...hpComponents]);

function loadFixture(name: string): { html: string } {
  const file = readdirSync(FIXTURES).find((f) => f.startsWith(name) && f.endsWith(".json"));
  assert.ok(file, `fixture ${name} present`);
  const body = JSON.parse(readFileSync(new URL(file!, FIXTURES), "utf8")) as { html: string };
  assert.ok(body.html);
  return body;
}

function convertFixture(name: string, pageTitle: string) {
  const { html } = loadFixture(name);
  const result = convert(html, { pageTitle, mapping: hpMapping, mapAsk });
  assert.ok(result.markdown, `${name}: conversion produced markdown`);
  const { root, issues: parseIssues } = parseDocument(result.markdown!);
  assert.ok(root, `${name}: output re-parses`);
  const { issues, components } = validateDocument(registry, root!, {
    ns: "main",
    slug: pageTitle.replace(/ /g, "_"),
    title: pageTitle,
  });
  const all = [...parseIssues, ...issues, ...checkQueries(registry, components)];
  assert.ok(!hasErrors(all), `${name}: validates against HP registry: ${JSON.stringify(all.filter((i) => i.severity === "error").slice(0, 3))}`);
  return { result, components };
}

test("sonic prototype page converts, validates, and keeps its structure", { skip: !HAVE_FIXTURES && "parsoid fixtures not present" }, () => {
  const { result, components } = convertFixture("sonic", "Sonic the Hedgehog 2 (Nick Arcade prototype)");
  const names = components.map((c) => c.name);
  assert.ok(names.includes("Prototype"));
  assert.ok(names.includes("Download"));
  assert.ok(names.includes("FileList"));
  assert.ok(names.includes("FileEntry"));
  assert.ok(names.includes("GameNav"));
  assert.ok(names.filter((n) => n === "Gallery").length >= 2);

  const proto = components.find((c) => c.name === "Prototype")!;
  assert.equal(proto.attrs.game, "Sonic the Hedgehog 2");
  assert.equal(proto.attrs.system, "Sega Mega Drive");
  assert.equal(proto.attrs.sortNumber, 1);
  assert.deepEqual(proto.attrs.dumpedBy, ["drx"]);
  const releaseDate = proto.attrs.releaseDate as { region: string; date: string }[];
  assert.equal(releaseDate.length, 3);
  assert.equal(releaseDate[0]!.region, "JP");
  assert.equal(releaseDate[0]!.date, "1992-11-21");

  assert.ok(result.markdown!.includes("## Notes"));
  assert.ok(result.markdown!.includes("[[171-5694-01]]"));
  assert.ok(result.categories.includes("Sonic the Hedgehog 2 prototypes"));
  assert.ok(!result.warnings.some((w) => w.severity === "error"));
});

test("videos list page becomes a Query", { skip: !HAVE_FIXTURES && "parsoid fixtures not present" }, () => {
  const { components } = convertFixture("videos", "Videos list");
  const query = components.find((c) => c.name === "Query");
  assert.ok(query, "ask became <Query>");
  assert.equal(query!.attrs.from, "Video");
  assert.equal(query!.attrs.limit, 3000);
});

test("board page converts once (dedupe) with typed attrs", { skip: !HAVE_FIXTURES && "parsoid fixtures not present" }, () => {
  const { components } = convertFixture("171", "171-5694-01");
  const boards = components.filter((c) => c.name === "Board");
  assert.equal(boards.length, 1);
  assert.equal(boards[0]!.attrs.hardwareId, "171-5694-01");
  assert.equal(boards[0]!.attrs.system, "Sega Mega Drive");
});
