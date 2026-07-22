/**
 * Converter follow-ups: structured hex-snippet parsing (romutils.py header
 * dumps -> <HexDump> childrenJson) and the recentchanges sync worker.
 * Offline: real Parsoid fixture for the hexdump, injected fakes for sync.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fromHtml } from "hast-util-from-html";
import { convert } from "../src/import/mediawiki/index";
import { parseHexSnippets } from "../src/import/mediawiki/hexdump";
import { syncRecentChanges, type SyncSaveInput } from "../src/import/mediawiki/sync";
import type { ConversionResult } from "../src/import/mediawiki/types";
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

/* ---- Track A: parseHexSnippets ---------------------------------------------- */

test("sonic hex snippet parses into one structured dump", { skip: !HAVE_FIXTURES && "parsoid fixtures not present" }, () => {
  const { html } = loadFixture("sonic");
  const groups = parseHexSnippets(fromHtml(html));
  const parsed = groups.filter((g) => g.data !== null);
  assert.equal(parsed.length, 1);

  const data = parsed[0]!.data!;
  assert.ok(data.lines.length >= 10, `expected >= 10 lines, got ${data.lines.length}`);
  assert.equal(data.lines.length, 16);
  assert.equal(data.lines[0]!.offset, "00000100");
  assert.equal(data.lines[0]!.bytes, "53 45 47 41 20 4d 45 47 41 20 44 52 49 56 45 20");
  assert.equal(data.lines[0]!.ascii, "SEGA MEGA DRIVE ");

  const system = data.annotations.find((a) => a.field === "System name");
  assert.ok(system, "System name annotation present");
  assert.equal(system!.value, "Sega Mega Drive");
  assert.equal(system!.line, 0);
  assert.equal(system!.start, 0);
  assert.equal(system!.length, 16); // two 8-byte column spans merged

  // Sub-line ranges survive: serial (14 bytes) then checksum (2 bytes).
  const checksum = data.annotations.find((a) => a.field === "Checksum");
  assert.ok(checksum, "Checksum annotation present");
  assert.equal(checksum!.value, "0xAFC7");
  assert.equal(checksum!.start, 14);
  assert.equal(checksum!.length, 2);
  const serial = data.annotations.find((a) => a.field === "Serial");
  assert.ok(serial);
  assert.deepEqual([serial!.line, serial!.start, serial!.length], [checksum!.line, 0, 14]);
});

test("consecutive sibling snippets group; garbage snippets return data null", { skip: !HAVE_FIXTURES && "parsoid fixtures not present" }, () => {
  const html =
    '<body><p id="a">' +
    '<span class="hex-snippet">00000000  <span class="hover-link" data-title="F" title="V">41 42</span>  A.</span>\n' +
    '<span class="hex-snippet">00000010  43 44  C.</span>' +
    "</p>" +
    '<p id="b"><span class="hex-snippet">this is not a hexdump</span></p></body>';
  const groups = parseHexSnippets(fromHtml(html));
  assert.equal(groups.length, 2);

  const [dump, garbage] = groups;
  assert.ok(dump!.data, "adjacent snippets parse as one dump");
  assert.equal(dump!.snippets.length, 2);
  assert.equal(dump!.data!.lines.length, 2);
  assert.equal(dump!.data!.lines[0]!.offset, "00000000");
  assert.equal(dump!.data!.lines[1]!.offset, "00000010");
  assert.equal(dump!.data!.lines[1]!.bytes, "43 44");
  assert.equal(dump!.data!.lines[1]!.ascii, "C.");
  assert.deepEqual(dump!.data!.annotations, [
    { line: 0, start: 0, length: 2, field: "F", value: "V" },
  ]);

  assert.equal(garbage!.data, null, "unparseable snippet returns data null");
});

/* ---- Track A: full conversion ------------------------------------------------ */

test("sonic page converts with a structured HexDump and still validates", { skip: !HAVE_FIXTURES && "parsoid fixtures not present" }, () => {
  const { html } = loadFixture("sonic");
  const pageTitle = "Sonic the Hedgehog 2 (Nick Arcade prototype)";
  const result = convert(html, { pageTitle, mapping: hpMapping, mapAsk });
  assert.ok(result.markdown, "conversion produced markdown");

  assert.ok(result.markdown!.includes("<HexDump"), "output contains <HexDump");
  assert.ok(/```json[\s\S]*00000100[\s\S]*```/.test(result.markdown!), "fenced json child holds the dump");

  const { root, issues: parseIssues } = parseDocument(result.markdown!);
  assert.ok(root, "output re-parses");
  const { issues, components } = validateDocument(registry, root!, {
    ns: "main",
    slug: pageTitle.replace(/ /g, "_"),
    title: pageTitle,
  });
  const all = [...parseIssues, ...issues, ...checkQueries(registry, components)];
  assert.ok(
    !hasErrors(all),
    `validates against HP registry: ${JSON.stringify(all.filter((i) => i.severity === "error").slice(0, 3))}`,
  );

  const hexdump = components.find((c) => c.name === "HexDump");
  assert.ok(hexdump, "HexDump component instance extracted");
  const data = hexdump!.childrenJson as { lines: unknown[]; annotations: unknown[] };
  assert.equal(data.lines.length, 16);
  assert.ok(data.annotations.length > 0);
});

/* ---- Track B: syncRecentChanges ---------------------------------------------- */

function conversion(markdown: string | null): ConversionResult {
  return { markdown, ok: markdown !== null, warnings: [], categories: [] };
}

test("syncRecentChanges pages, dedupes titles, filters ns, collects failures", { skip: !HAVE_FIXTURES && "parsoid fixtures not present" }, async () => {
  const rcUrls: string[] = [];
  const batches: unknown[] = [
    {
      continue: { rccontinue: "next-page" },
      query: {
        recentchanges: [
          { ns: 0, title: "Alpha", user: "u1", comment: "first", timestamp: "2026-07-20T10:00:00Z" },
          { ns: 6, title: "File:Skip.png", user: "u1", comment: "file", timestamp: "2026-07-20T10:05:00Z" },
          { ns: 0, title: "Alpha", user: "u2", comment: "second", timestamp: "2026-07-20T10:10:00Z" },
        ],
      },
    },
    {
      query: {
        recentchanges: [
          { ns: 0, title: "Broken", user: "u3", comment: "boom", timestamp: "2026-07-20T10:20:00Z" },
          { ns: 0, title: "Fallback", user: "u4", comment: "fb", timestamp: "2026-07-20T10:30:00Z" },
        ],
      },
    },
  ];

  const saves: SyncSaveInput[] = [];
  const wikitextFetched: string[] = [];

  const res = await syncRecentChanges({
    baseUrl: "https://wiki.example",
    since: "2026-07-20T09:00:00Z",
    convert: (title) => conversion(title === "Fallback" ? null : `# ${title}`),
    save: async (input) => {
      if (input.title === "Broken") throw new Error("db down");
      saves.push(input);
    },
    fetchJson: async (url) => {
      rcUrls.push(url);
      return batches.shift();
    },
    fetchHtml: async (_base, title) => ({ title, revisionId: 1, html: `<p>${title}</p>` }),
    fetchWikitext: async (_base, title) => {
      wikitextFetched.push(title);
      return `wikitext of ${title}`;
    },
  });

  // Paging: first call carries rcstart, second the rccontinue token.
  assert.equal(rcUrls.length, 2);
  assert.ok(rcUrls[0]!.includes("list=recentchanges"));
  assert.ok(rcUrls[0]!.includes(encodeURIComponent("2026-07-20T09:00:00Z")));
  assert.ok(!rcUrls[0]!.includes("rccontinue"));
  assert.ok(rcUrls[1]!.includes("rccontinue=next-page"));

  // Alpha deduped to its latest change; File: ns skipped; Broken failed.
  assert.equal(res.processed, 2);
  assert.equal(res.newSince, "2026-07-20T10:30:00Z");
  assert.deepEqual(res.failures, [{ title: "Broken", error: "db down" }]);

  assert.equal(saves.length, 2);
  const alpha = saves.find((s) => s.title === "Alpha")!;
  assert.equal(alpha.markdown, "# Alpha");
  // History carries MW syntax: wikitext is fetched for every change now.
  assert.equal(alpha.wikitext, "wikitext of Alpha");
  assert.equal(alpha.author, "u2");
  assert.equal(alpha.comment, "second");
  assert.equal(alpha.timestamp, "2026-07-20T10:10:00Z");

  const fallback = saves.find((s) => s.title === "Fallback")!;
  assert.equal(fallback.markdown, null);
  assert.equal(fallback.wikitext, "wikitext of Fallback");
  assert.deepEqual(new Set(wikitextFetched), new Set(["Alpha", "Broken", "Fallback"]));
});

test("syncRecentChanges honors the entry limit while paging", { skip: !HAVE_FIXTURES && "parsoid fixtures not present" }, async () => {
  let calls = 0;
  const entry = (n: number) => ({
    ns: 0,
    title: `Page ${n}`,
    user: "u",
    comment: "",
    timestamp: `2026-07-20T10:${String(n).padStart(2, "0")}:00Z`,
  });
  const saves: string[] = [];
  const res = await syncRecentChanges({
    baseUrl: "https://wiki.example",
    since: "2026-07-20T09:00:00Z",
    limit: 3,
    convert: (title) => conversion(`# ${title}`),
    save: async (input) => {
      saves.push(input.title);
    },
    fetchJson: async () => {
      calls++;
      return {
        continue: { rccontinue: `c${calls}` },
        query: { recentchanges: [entry(calls * 2 - 1), entry(calls * 2)] },
      };
    },
    fetchHtml: async (_base, title) => ({ title, revisionId: 1, html: "<p>x</p>" }),
    fetchWikitext: async (_base, title) => `wt of ${title}`,
  });
  assert.equal(calls, 2); // stopped paging once the limit was reached
  assert.equal(res.processed, 3); // 4 fetched, truncated to limit 3
  assert.deepEqual(saves, ["Page 1", "Page 2", "Page 3"]);
  assert.equal(res.newSince, "2026-07-20T10:03:00Z");
});
