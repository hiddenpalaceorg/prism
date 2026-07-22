// Continuous sync from the live hiddenpalace.org wiki into the local cube
// instance: poll recentchanges, convert the touched pages via the HP mapping,
// save (wikitext fallback when conversion fails), remember the high-water
// timestamp in a state file.
//
//   npx tsx web/scripts/sync-wiki.mts                 one pass (default)
//   npx tsx web/scripts/sync-wiki.mts --loop 300      poll every 5 minutes
//   npx tsx web/scripts/sync-wiki.mts --since 2026-07-20T00:00:00Z
//
// Flags: --state <path>   state file (default web/.wiki-sync-state.json)
//        --since <ts>     initial MW ISO timestamp (first run only; state wins)
//        --loop <seconds> keep polling; --once is the default
//        --limit <n>      max recent-change entries per pass (default 500)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createCube } from "cube";
import { convert, importRevision, syncRecentChanges, type SyncSaveInput } from "cube/import/mediawiki";
import { hpComponents } from "../src/cube/schemas";
import { hpMapping, mapAsk } from "../src/cube/mapping";

const BASE = process.env.WIKI_BASE_URL ?? "https://hiddenpalace.org";

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const statePath = argValue("--state") ?? fileURLToPath(new URL("../.wiki-sync-state.json", import.meta.url));
const loopArg = argValue("--loop");
const loopSeconds = loopArg !== undefined ? Number.parseInt(loopArg, 10) : null;
const limitArg = argValue("--limit");
const limit = limitArg !== undefined ? Number.parseInt(limitArg, 10) : 500;

if (loopSeconds !== null && (!Number.isFinite(loopSeconds) || loopSeconds <= 0)) {
  console.error("--loop takes a positive number of seconds");
  process.exit(2);
}

function readSince(): string {
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { since?: string };
    if (typeof state.since === "string" && state.since !== "") return state.since;
  }
  return argValue("--since") ?? new Date().toISOString();
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || "postgres:///curator",
  statement_timeout: 60_000,
});
const cube = createCube({ db: { pool }, components: hpComponents });

async function save(input: SyncSaveInput): Promise<void> {
  if (input.wikitext === null || input.revId === null) {
    throw new Error("sync requires wikitext + revid for history provenance");
  }
  // History carries the original MW syntax: wikitext revision first, then
  // the converted markdown on top (idempotent by mw_rev_id).
  const saved = await importRevision(cube, {
    title: input.title,
    wikitext: input.wikitext,
    mwRevId: input.revId,
    mwAuthor: input.author || "unknown",
    mwTimestamp: input.timestamp ? new Date(input.timestamp) : new Date(),
    mwComment: input.comment,
    markdown: input.markdown,
  });
  console.error(
    `${saved.outcome} ${input.title} head r${saved.headRevId}` +
      (saved.validationIssues ? " (conversion failed validation, wikitext head)" : ""),
  );
}

async function runOnce(since: string): Promise<string> {
  const res = await syncRecentChanges({
    baseUrl: BASE,
    since,
    limit,
    convert: (title, html) => convert(html, { pageTitle: title, mapping: hpMapping, mapAsk }),
    save,
  });
  for (const f of res.failures) console.error(`FAIL ${f.title}: ${f.error}`);
  console.error(
    `synced ${res.processed} page(s), ${res.failures.length} failure(s), since -> ${res.newSince}`,
  );
  writeFileSync(statePath, JSON.stringify({ since: res.newSince }, null, 2) + "\n");
  return res.newSince;
}

let since = readSince();
console.error(`syncing ${BASE} since ${since} (state: ${statePath})`);

if (loopSeconds !== null) {
  for (;;) {
    try {
      since = await runOnce(since);
    } catch (err) {
      console.error(`sync pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, loopSeconds * 1000));
  }
} else {
  await runOnce(since);
  await pool.end();
}
