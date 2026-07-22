// Batch-import wiki pages into the local cube instance from a titles TSV
// (cube/spikes/data/all-titles.tsv format: ns_id TAB title-with-prefix).
// Converts each page via the HP mapping; when conversion fails the raw
// wikitext is stored with wikitextFallback. Failures append to
// web/.wiki-import-failures.log (title TAB error); resume with --offset.
//
//   npx tsx web/scripts/import-wiki-batch.mts --titles cube/spikes/data/all-titles.tsv \
//     [--limit N] [--concurrency 3] [--offset N] [--ns 0]

import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createCube } from "cube";
import { convert, importRevision } from "cube/import/mediawiki";
import { fetchParsoidHtml, fetchRevisionInfo } from "cube/import/mediawiki/fetch";
import { hpComponents } from "../src/cube/schemas";
import { hpMapping, mapAsk } from "../src/cube/mapping";

const BASE = process.env.WIKI_BASE_URL ?? "https://hiddenpalace.org";
const FETCH_DELAY_MS = 150; // per worker, between pages

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function argNumber(name: string, fallback: number): number {
  const v = argValue(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`${name} takes a non-negative integer`);
    process.exit(2);
  }
  return n;
}

const titlesPath = argValue("--titles");
if (!titlesPath) {
  console.error(
    "usage: import-wiki-batch.mts --titles <file> [--limit N] [--concurrency 3] [--offset N] [--ns 0]",
  );
  process.exit(2);
}
const limit = argNumber("--limit", Number.MAX_SAFE_INTEGER);
const concurrency = Math.max(1, argNumber("--concurrency", 3));
const offset = argNumber("--offset", 0);
const ns = argNumber("--ns", 0);

const failureLog = fileURLToPath(new URL("../.wiki-import-failures.log", import.meta.url));

const titles = readFileSync(titlesPath, "utf8")
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => {
    const tab = line.indexOf("\t");
    return { ns: Number.parseInt(line.slice(0, tab), 10), title: line.slice(tab + 1) };
  })
  .filter((row) => row.ns === ns && row.title !== "")
  .map((row) => row.title);

const queue = titles.slice(offset, limit === Number.MAX_SAFE_INTEGER ? undefined : offset + limit);
console.error(`importing ${queue.length} page(s) (ns ${ns}, offset ${offset}) from ${BASE}`);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgres:///curator",
  statement_timeout: 60_000,
});
const cube = createCube({ db: { pool }, components: hpComponents });



let next = 0;
let done = 0;
let failed = 0;
let fallbacks = 0;

async function worker(): Promise<void> {
  for (;;) {
    const i = next++;
    if (i >= queue.length) return;
    const title = queue[i]!;
    try {
      // History carries the original MW syntax: wikitext revision first
      // (original author/timestamp, mw_rev_id provenance), converted
      // markdown on top. Idempotent by mw_rev_id.
      const page = await fetchParsoidHtml(BASE, title);
      const result = convert(page.html, { pageTitle: title, mapping: hpMapping, mapAsk });
      const info = await fetchRevisionInfo(BASE, title);
      const saved = await importRevision(cube, {
        title,
        wikitext: info.wikitext,
        mwRevId: info.revId,
        mwAuthor: info.author,
        mwTimestamp: info.timestamp,
        mwComment: info.comment,
        markdown: result.markdown,
      });
      if (result.markdown === null || saved.validationIssues) {
        fallbacks++;
        if (saved.validationIssues) {
          appendFileSync(failureLog, `${title}\tVALIDATION->wikitext head: ${saved.validationIssues[0]?.message ?? ""}\n`);
        }
      }
    } catch (err) {
      failed++;
      const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ");
      appendFileSync(failureLog, `${title}\t${message}\n`);
    }
    done++;
    if (done % 10 === 0) {
      console.error(`${done}/${queue.length} (${failed} failed, ${fallbacks} wikitext fallbacks)`);
    }
    await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
console.error(
  `done: ${done}/${queue.length} (${failed} failed, ${fallbacks} wikitext fallbacks); next --offset ${offset + done}`,
);
if (failed > 0) console.error(`failures logged to ${failureLog}`);
await pool.end();
