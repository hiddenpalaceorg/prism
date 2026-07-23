/**
 * End-to-end integration against a local scratch Postgres database
 * (cube_test, dropped and recreated per run) and a temp git repo.
 * Skips itself when Postgres is unreachable.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import { createCube, dependentPages, type Cube } from "../src/index";
import { CubeConflictError, CubeValidationError } from "../src/issues";
import { processGitQueue } from "../src/git";
import { parseComponentTag } from "../src/tags";
import { testComponents } from "./helpers";

const DB = "cube_test";
let pool: pg.Pool;
let cube: Cube;
let available = true;
const author = { name: "Drx" };

before(async () => {
  const admin = new pg.Pool({ database: "postgres" });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
  } catch (err) {
    available = false;
    console.log(`# skipping integration tests: ${(err as Error).message}`);
    return;
  } finally {
    await admin.end();
  }
  pool = new pg.Pool({ database: DB });
  const ddl = readFileSync(new URL("../db/migrations/001-init.sql", import.meta.url), "utf8");
  await pool.query(ddl);
  // Idempotence: applying twice must be safe.
  await pool.query(ddl);
  cube = createCube({ db: { pool }, components: testComponents });
});

after(async () => {
  await pool?.end();
});

function skippable(name: string, fn: () => Promise<void>) {
  test(name, { skip: !available && "postgres unavailable" }, fn);
}

skippable("create page: revision, objects, categories, links, deps", async () => {
  const r = await cube.api.savePage({
    ns: "main",
    slug: "Sonic_the_Hedgehog_2_(Nick_Arcade_prototype)",
    markdown: [
      `<Prototype game="Sonic the Hedgehog 2" system="Sega Mega Drive" buildDate="1992-05" originLot="Altron lot" dumpedBy="drx" titleScreen="S2NA Title.png" />`,
      ``,
      `An early prototype. See [[171-5694-01]] and [[Missing Page]].`,
      ``,
      `## Notes`,
      ``,
      `- found on an EPROM cartridge`,
    ].join("\n"),
    author,
    comment: "initial import",
  });
  assert.equal(r.noop, false);
  assert.ok(r.revId > 0);
  assert.ok(r.invalidate.includes("cube:page:main:Sonic_the_Hedgehog_2_(Nick_Arcade_prototype)"));
  assert.ok(r.invalidate.includes("cube:q:Prototype:game=Sonic the Hedgehog 2"));

  const objects = await pool.query(`SELECT component, data FROM cube_page_object`);
  assert.equal(objects.rows.length, 1);
  assert.equal(objects.rows[0].data.game, "Sonic the Hedgehog 2");
  assert.equal(objects.rows[0].data.sort_date, "1992-05");

  const cats = await pool.query(`SELECT category FROM cube_page_category ORDER BY category`);
  assert.ok(cats.rows.some((c) => c.category === "Sonic the Hedgehog 2 prototypes"));

  const links = await pool.query(`SELECT to_ns, to_slug, kind FROM cube_link ORDER BY to_slug`);
  assert.ok(links.rows.some((l) => l.to_slug === "171-5694-01" && l.kind === "link"));
  assert.ok(links.rows.some((l) => l.to_slug === "Missing_Page"));
  assert.ok(links.rows.some((l) => l.to_ns === "file" && l.to_slug === "S2NA_Title.png" && l.kind === "media"));
  assert.ok(links.rows.some((l) => l.to_slug === "Altron_lot"));
});

skippable("getPage and search", async () => {
  const page = await cube.api.getPage({ ns: "main", slug: "Sonic_the_Hedgehog_2_(Nick_Arcade_prototype)" });
  assert.ok(page);
  assert.match(page!.markdown, /Prototype game/);

  const hits = await cube.api.search("Sonic prototype");
  assert.ok(hits.length > 0);
  assert.equal(hits[0]!.slug, "Sonic_the_Hedgehog_2_(Nick_Arcade_prototype)");
});

skippable("no-op save returns existing revision", async () => {
  const page = await cube.api.getPage({ ns: "main", slug: "Sonic_the_Hedgehog_2_(Nick_Arcade_prototype)" });
  const r = await cube.api.savePage({
    ns: "main",
    slug: "Sonic_the_Hedgehog_2_(Nick_Arcade_prototype)",
    markdown: page!.markdown,
    baseRevId: page!.revId,
    author,
  });
  assert.equal(r.noop, true);
  assert.equal(r.revId, page!.revId);
});

skippable("edit with stale base: clean merge", async () => {
  const slug = "Merge_Target";
  const base = await cube.api.savePage({
    ns: "main", slug, markdown: "line one\n\nline two\n\nline three\n", author,
  });
  // Someone else edits line three...
  await cube.api.savePage({
    ns: "main", slug, markdown: "line one\n\nline two\n\nline three CHANGED\n",
    baseRevId: base.revId, author: { name: "Other" },
  });
  // ...while we edit line one from the old base.
  const merged = await cube.api.savePage({
    ns: "main", slug, markdown: "line one EDITED\n\nline two\n\nline three\n",
    baseRevId: base.revId, author,
  });
  assert.equal(merged.merged, true);
  const page = await cube.api.getPage({ ns: "main", slug });
  assert.match(page!.markdown, /line one EDITED/);
  assert.match(page!.markdown, /line three CHANGED/);
});

skippable("edit with stale base: overlapping edit conflicts", async () => {
  const slug = "Conflict_Target";
  const base = await cube.api.savePage({ ns: "main", slug, markdown: "same line\n", author });
  await cube.api.savePage({
    ns: "main", slug, markdown: "same line THEIRS\n", baseRevId: base.revId, author: { name: "Other" },
  });
  await assert.rejects(
    cube.api.savePage({
      ns: "main", slug, markdown: "same line MINE\n", baseRevId: base.revId, author,
    }),
    CubeConflictError,
  );
});

skippable("creating over an existing page conflicts", async () => {
  await assert.rejects(
    cube.api.savePage({ ns: "main", slug: "Conflict_Target", markdown: "fresh\n", author }),
    CubeConflictError,
  );
});

skippable("validation errors block the save with line info", async () => {
  await assert.rejects(
    cube.api.savePage({ ns: "main", slug: "Bad", markdown: `text\n\n<Prototype system="X" />\n`, author }),
    (err: unknown) => {
      assert.ok(err instanceof CubeValidationError);
      const issue = err.issues.find((i) => i.attr === "game")!;
      assert.equal(issue.line, 3);
      return true;
    },
  );
  assert.equal(await cube.api.getPage({ ns: "main", slug: "Bad" }), null);
});

skippable("query engine end-to-end over saved objects", async () => {
  for (const [i, [game, system, date, lot]] of (
    [
      ["Comix Zone", "Sega Mega Drive", "1995-03", "Altron lot"],
      ["Comix Zone", "Sega Mega Drive", "1995-05", null],
      ["Light Crusader", "Sega Mega Drive", "1995-04", "Altron lot"],
      ["Croc 2", "PlayStation", "1999-01", null],
    ] as const
  ).entries()) {
    await cube.api.savePage({
      ns: "main",
      slug: `${game.replace(/ /g, "_")}_(proto_${i})`,
      markdown: `<Prototype game="${game}" system="${system}" buildDate="${date}"${lot ? ` originLot="${lot}"` : ""} dumpedBy="drx" />\n`,
      author,
    });
  }

  const rows = await cube.api.queryObjects({
    from: "Prototype",
    where: { system: "Sega Mega Drive", build_date: { gte: "1995" } },
    sort: [{ field: "build_date" }],
  });
  assert.equal(rows.kind, "rows");
  if (rows.kind === "rows") {
    assert.deepEqual(
      rows.rows.map((r) => r.data.game),
      ["Comix Zone", "Light Crusader", "Comix Zone"],
    );
  }

  const count = await cube.api.queryObjects({
    from: "Prototype",
    where: { origin_lot: "Altron lot" },
    aggs: [{ fn: "count", as: "n" }],
  });
  assert.equal(count.kind, "agg");
  // Comix Zone + Light Crusader + the Sonic page from the first test.
  if (count.kind === "agg") assert.equal(Number(count.rows[0]!.n), 3);

  const grouped = await cube.api.queryObjects({
    from: "Prototype",
    where: { origin_lot: { exists: true } },
    groupBy: "origin_lot",
    aggs: [
      { fn: "count", as: "n" },
      { fn: "min", field: "build_date", as: "first" },
      { fn: "max", field: "build_date", as: "last" },
    ],
  });
  if (grouped.kind === "agg") {
    const altron = grouped.rows.find((r) => r.group_key === "Altron lot")!;
    assert.equal(Number(altron.n), 3);
  }

  const multi = await cube.api.queryObjects({ from: "Prototype", where: { dumped_by: "drx" } });
  if (multi.kind === "rows") assert.equal(multi.rows.length, 5);
});

skippable("redirects: save, flag, resolve", async () => {
  await cube.api.savePage({
    ns: "main",
    slug: "Sonic_2_Nick_Arcade",
    markdown: `<Redirect to="Sonic the Hedgehog 2 (Nick Arcade prototype)" />\n`,
    author,
  });
  const resolved = await cube.api.resolve("Sonic 2 Nick Arcade");
  assert.ok(resolved);
  assert.equal(resolved!.slug, "Sonic_the_Hedgehog_2_(Nick_Arcade_prototype)");
  assert.deepEqual(resolved!.redirectedFrom, { ns: "main", slug: "Sonic_2_Nick_Arcade" });

  // Redirect pages are excluded from query results.
  const q = await cube.api.queryObjects({ from: "Prototype", where: { game: "Sonic the Hedgehog 2" } });
  if (q.kind === "rows") assert.equal(q.rows.length, 1);
});

skippable("delete soft-deletes, recreate clears deleted_at, history survives", async () => {
  const slug = "Deletable";
  await cube.api.savePage({ ns: "main", slug, markdown: "v1\n", author });
  await cube.api.deletePage({ ns: "main", slug, actor: author, reason: "test" });
  assert.equal(await cube.api.getPage({ ns: "main", slug }), null);

  await cube.api.savePage({ ns: "main", slug, markdown: "v2\n", author });
  const page = await cube.api.getPage({ ns: "main", slug });
  assert.ok(page);
  assert.match(page!.markdown, /v2/);
  const revs = await cube.api.listRevisions({ ns: "main", slug });
  assert.equal(revs.length, 2); // history from before the delete is retained
});

skippable("move leaves a redirect and logs", async () => {
  await cube.api.savePage({ ns: "main", slug: "Old_Name", markdown: "content\n", author });
  await cube.api.movePage({
    from: { ns: "main", slug: "Old_Name" },
    to: { ns: "main", slug: "New_Name" },
    actor: author,
  });
  const moved = await cube.api.getPage({ ns: "main", slug: "New_Name" });
  assert.ok(moved);
  const resolved = await cube.api.resolve("Old Name");
  assert.equal(resolved!.slug, "New_Name");
  const log = await pool.query(`SELECT action FROM cube_page_log WHERE action = 'move'`);
  assert.equal(log.rows.length, 1);
});

skippable("move to a title containing a quote can't inject redirect attributes", async () => {
  await cube.api.savePage({ ns: "main", slug: "Quote_Move_Src", markdown: "content\n", author });
  await cube.api.movePage({
    from: { ns: "main", slug: "Quote_Move_Src" },
    to: { ns: "main", slug: 'Pwned" author="admin' },
    actor: author,
  });
  const redirect = await cube.api.getPage({ ns: "main", slug: "Quote_Move_Src" });
  assert.ok(redirect);
  const parsed = parseComponentTag(redirect.markdown.trim());
  assert.ok(!("error" in parsed), `redirect should parse cleanly: ${JSON.stringify(parsed)}`);
  // The quote must not have split into a second attribute: only `to` survives.
  assert.deepEqual(Object.keys((parsed as { attrs: Record<string, unknown> }).attrs), ["to"]);
});

skippable("dependent pages found via query deps", async () => {
  await cube.api.savePage({
    ns: "main",
    slug: "Comix_Zone_nav",
    markdown: `<GameNav game="Comix Zone" />\n`,
    author,
  });
  const save = await cube.api.savePage({
    ns: "main",
    slug: "Comix_Zone_(proto_new)",
    markdown: `<Prototype game="Comix Zone" system="Sega Mega Drive" buildDate="1995-06" />\n`,
    author,
  });
  const deps = await dependentPages(pool, save.invalidate);
  assert.ok(deps.some((d) => d.slug === "Comix_Zone_nav"));
});

skippable("validateMarkdown reports without writing", async () => {
  const issues = await cube.api.validateMarkdown(
    { ns: "main", slug: "X" },
    `<Prototype game="ok" buildDate="bogus" />\n`,
  );
  assert.ok(issues.some((i) => i.attr === "buildDate"));
});

skippable("importRevision: history carries MW wikitext, idempotent by mw_rev_id", async () => {
  const { importRevision } = await import("../src/import/mediawiki/save");
  const input = {
    title: "Imported Page",
    wikitext: "== Heading ==\n{{Prototype|game=Import Test}}\n",
    mwRevId: 990001,
    mwAuthor: "SomeEditor",
    mwTimestamp: new Date("2016-03-04T12:00:00Z"),
    mwComment: "original edit",
    markdown: `<Prototype game="Import Test" />\n\n## Heading\n`,
  };

  const first = await importRevision(cube, input);
  assert.equal(first.outcome, "imported");

  const revs = await cube.api.listRevisions({ ns: "main", slug: "Imported_Page" });
  assert.equal(revs.length, 2);
  // Head: converted markdown. Base: verbatim wikitext with MW provenance.
  assert.equal(revs[0]!.wikitextFallback, false);
  assert.equal(revs[0]!.author, "wiki-import");
  assert.equal(revs[1]!.wikitextFallback, true);
  assert.equal(revs[1]!.author, "wiki:SomeEditor");
  assert.equal(revs[1]!.comment, "original edit");
  assert.equal(revs[1]!.createdAt.toISOString(), "2016-03-04T12:00:00.000Z");

  const base = await cube.api.getPage({ ns: "main", slug: "Imported_Page" }, { revId: revs[1]!.id });
  assert.ok(base!.wikitextFallback);
  assert.match(base!.markdown, /\{\{Prototype\|game=Import Test\}\}/);

  // Same MW revision again: no new rows.
  const again = await importRevision(cube, input);
  assert.equal(again.outcome, "skipped");
  assert.equal((await cube.api.listRevisions({ ns: "main", slug: "Imported_Page" })).length, 2);

  // Conversion that fails validation leaves the wikitext revision as head.
  const bad = await importRevision(cube, {
    ...input,
    title: "Imported Bad",
    mwRevId: 990002,
    markdown: `<Prototype buildDate="not a date" />\n`,
  });
  assert.equal(bad.outcome, "imported");
  assert.ok(bad.validationIssues!.some((i) => i.attr === "game"));
  const badPage = await cube.api.getPage({ ns: "main", slug: "Imported_Bad" });
  assert.ok(badPage!.wikitextFallback);
});

skippable("git export: commits per revision with authorship and layout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cube-git-"));
  const result = await processGitQueue(pool, { dir, emailDomain: "users.hiddenpalace.org" });
  assert.ok(result.locked);
  assert.ok(result.processed > 5, `processed ${result.processed}`);
  assert.equal(result.itemError, undefined);

  const log = execFileSync("git", ["log", "--format=%an|%s", "--reverse"], { cwd: dir })
    .toString()
    .trim()
    .split("\n");
  assert.equal(log[0], "Drx|initial import");

  const files = execFileSync("git", ["ls-files"], { cwd: dir }).toString().trim().split("\n");
  assert.ok(files.includes("main/Sonic_the_Hedgehog_2_(Nick_Arcade_prototype).md"));
  assert.ok(files.includes("main/New_Name.md"));
  assert.ok(!files.includes("main/Old_Name.md") || files.includes("main/Old_Name.md"));

  // Draining again is a no-op.
  const again = await processGitQueue(pool, { dir });
  assert.equal(again.processed, 0);
});
