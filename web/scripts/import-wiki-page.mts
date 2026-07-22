// Import a single page from the live hiddenpalace.org wiki into the local
// cube instance. History carries the original wikitext: the MW revision saves
// verbatim first (original author/timestamp/comment, mw_rev_id provenance),
// then the converted markdown lands on top.
//
//   npx tsx web/scripts/import-wiki-page.mts "Sonic the Hedgehog 2 (Nick Arcade prototype)"
//   npx tsx web/scripts/import-wiki-page.mts "Some Page" --save
//
// Flags: --save (write into DATABASE_URL, default postgres:///curator),
//        --wikitext (print the source wikitext too), --quiet (markdown only)

import pg from "pg";
import { createCube } from "cube";
import { convert, importRevision } from "cube/import/mediawiki";
import { fetchParsoidHtml, fetchRevisionInfo } from "cube/import/mediawiki/fetch";
import { hpComponents } from "../src/cube/schemas";
import { hpMapping, mapAsk } from "../src/cube/mapping";

const BASE = process.env.WIKI_BASE_URL ?? "https://hiddenpalace.org";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const title = args.find((a) => !a.startsWith("--"));
if (!title) {
  console.error('usage: import-wiki-page.mts "Page Title" [--save] [--wikitext] [--quiet]');
  process.exit(2);
}

const page = await fetchParsoidHtml(BASE, title);
const result = convert(page.html, { pageTitle: title, mapping: hpMapping, mapAsk });

if (!flags.has("--quiet")) {
  console.error(`# ${title} (rev ${page.revisionId})`);
  console.error(`# categories: ${result.categories.join(", ") || "(none)"}`);
  for (const w of result.warnings) {
    console.error(`# ${w.severity.toUpperCase()} ${w.code}: ${w.message}`);
  }
  console.error(`# ok: ${result.ok}`);
  console.error("");
}

if (result.markdown !== null) console.log(result.markdown);
else console.error("conversion failed; the wikitext revision will be head");

if (flags.has("--wikitext") || flags.has("--save")) {
  const info = await fetchRevisionInfo(BASE, title);
  if (flags.has("--wikitext")) {
    console.error("\n===== original wikitext =====\n");
    console.error(info.wikitext);
  }
  if (flags.has("--save")) {
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL || "postgres:///curator",
      statement_timeout: 60_000,
    });
    const cube = createCube({ db: { pool }, components: hpComponents });
    const saved = await importRevision(cube, {
      title,
      wikitext: info.wikitext,
      mwRevId: info.revId,
      mwAuthor: info.author,
      mwTimestamp: info.timestamp,
      mwComment: info.comment,
      markdown: result.markdown,
    });
    console.error(`${saved.outcome}: head r${saved.headRevId}`);
    if (saved.validationIssues) {
      console.error("conversion failed validation; wikitext stays head:");
      for (const i of saved.validationIssues.slice(0, 5)) {
        console.error(`  ${i.line ?? "?"}:${i.column ?? "?"} [${i.rule}] ${i.message}`);
      }
    }
    await pool.end();
  }
}
