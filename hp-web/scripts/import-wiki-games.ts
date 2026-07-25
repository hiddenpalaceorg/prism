// Import per-build game classification from the Hidden Palace wiki mapping
// dumps:
//   wiki-map.json    articles <-> download files (sha1/url/size per download)
//   wiki-proto.json  article -> {{Prototype}} infobox fields (game, ...)
// Usage: npm run import-wiki-games -- --map wiki-map.json --proto wiki-proto.json [--dry-run]
//        (env DATABASE_URL)
//
// Joins builds to wiki downloads by archive sha1, then per matched build:
//  - upserts the infobox (game, system) pair into games (with its
//    /games/<slug> segment) and points builds.game_id at it. A NULL game_id
//    is filled; an existing assignment is migrated only when its current
//    game NAME equals the wiki-derived one (re-keying to the system-specific
//    row) — a moderator's different choice is never clobbered;
//  - renames the build to the article's as-typed File title (underscores and
//    spaces are interchangeable in MediaWiki titles, so the imported
//    underscored disk name is "supposed to be" the spaced title). A build
//    whose name no longer corresponds to its wiki file — i.e. a moderator
//    renamed it — is left alone. Game names are imported verbatim: infobox
//    text keeps intentional underscores (WATCH_DOGS), unlike file names.
// Any games row still missing a slug gets one (base slug, "-<id>" when a
// near-duplicate spelling took the base).
// --underscore-unmatched additionally rewrites _ to space in the name of
// every build whose sha1 is NOT in the map — only safe when every such build
// is known to carry a pristine wiki filename (e.g. curator_wiki, or strays
// whose wiki download was replaced after the dump was taken).
// --prune deletes games no build references afterwards (safe because games
// exist only through imports and assignments; an unassigned game is dead
// weight the combobox recreates on demand).

import fs from "node:fs";
import pg from "pg";
import { gameSlug } from "../src/lib/slug";
import { loadDotEnv } from "./dotenv";

interface MapDownload {
  file: string; // "File:..." title as typed in the article (spaced form)
  disk_path?: string; // canonical underscored filename on the MinIO box
  sha1?: string;
}
interface WikiMap {
  articles: Record<string, { url: string; downloads: MapDownload[] }>;
}
interface WikiProto {
  articles: Record<string, { url: string; prototype: Record<string, string> | null }>;
}

function usage(): never {
  console.error("usage: tsx scripts/import-wiki-games.ts --map wiki-map.json --proto wiki-proto.json [--dry-run]");
  process.exit(2);
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  loadDotEnv();
  const mapPath = arg("--map");
  const protoPath = arg("--proto");
  const dryRun = process.argv.includes("--dry-run");
  if (!mapPath || !protoPath) usage();

  const map = JSON.parse(fs.readFileSync(mapPath, "utf8")) as WikiMap;
  const proto = JSON.parse(fs.readFileSync(protoPath, "utf8")) as WikiProto;

  // sha1 -> the articles that link the download, the File titles it goes by
  // (as typed), and its canonical disk filenames.
  const bySha1 = new Map<string, { articles: Set<string>; files: Set<string>; disk: Set<string> }>();
  for (const [article, a] of Object.entries(map.articles)) {
    for (const d of a.downloads) {
      if (!d.sha1) continue;
      let e = bySha1.get(d.sha1);
      if (!e) bySha1.set(d.sha1, (e = { articles: new Set(), files: new Set(), disk: new Set() }));
      e.articles.add(article);
      e.files.add(d.file.replace(/^File:/, ""));
      if (d.disk_path) e.disk.add(d.disk_path.replace(/^.*\//, ""));
    }
  }

  // MediaWiki treats _ and whitespace runs as one space in titles, and
  // uppercases the leading letter on disk; compare under that equivalence.
  const collapse = (s: string) => s.replace(/[_\s]+/g, " ").trim();
  const norm = (s: string) => collapse(s).toLowerCase();

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL || "postgres:///prism_test",
    max: 4,
  });
  const rows = (
    await pool.query("SELECT sha256, sha1, name, game_id FROM builds")
  ).rows as { sha256: string; sha1: string; name: string; game_id: string | null }[];

  const renames: { sha256: string; name: string }[] = [];
  const assigns: { sha256: string; game: string; system: string }[] = [];
  const stats = {
    builds: rows.length,
    matched: 0,
    renamed: 0,
    game_assignable: 0,
    no_infobox_game: 0,
    ambiguous_game: 0,
    unmatched: 0,
  };

  const underscoreUnmatched = process.argv.includes("--underscore-unmatched");

  for (const b of rows) {
    const e = bySha1.get(b.sha1);
    if (!e) {
      stats.unmatched++;
      if (underscoreUnmatched && b.name.includes("_")) {
        renames.push({ sha256: b.sha256, name: b.name.replaceAll("_", " ") });
        stats.renamed++;
      }
      continue;
    }
    stats.matched++;

    // Prefer the article's as-typed title (it keeps intended casing like
    // "iCarly" that the disk name uppercases); fall back to the disk name's
    // own spaced form when the as-typed title is a redirect to a different
    // file. A name matching neither was chosen deliberately — leave it.
    const typed = [...e.files].find((f) => norm(f) === norm(b.name));
    const target = typed
      ? collapse(typed)
      : e.disk.has(b.name)
        ? b.name.replaceAll("_", " ")
        : undefined;
    if (target && target !== b.name) {
      renames.push({ sha256: b.sha256, name: target });
      stats.renamed++;
    }

    // Distinct (game, system) pairs across the articles linking this file;
    // the same title on two systems is two different games.
    const pairs = new Map<string, { game: string; system: string }>();
    for (const a of e.articles) {
      const pr = proto.articles[a]?.prototype;
      const g = pr?.game?.trim();
      if (!g) continue;
      const s = pr?.system?.trim() ?? "";
      pairs.set(`${g}\0${s}`, { game: g, system: s });
    }
    if (pairs.size === 1) {
      const [p] = pairs.values();
      assigns.push({ sha256: b.sha256, ...p });
      stats.game_assignable++;
    } else if (pairs.size > 1) {
      stats.ambiguous_game++;
      console.error(
        `ambiguous game for ${b.name} (${b.sha256.slice(0, 12)}): ` +
          [...pairs.values()].map((p) => `${p.game} [${p.system}]`).join(" | ")
      );
    } else {
      stats.no_infobox_game++;
    }
  }

  const pairKeys = new Map<string, { game: string; system: string }>();
  for (const a of assigns) pairKeys.set(`${a.game}\0${a.system}`, { game: a.game, system: a.system });
  const distinctPairs = [...pairKeys.values()];
  console.log(JSON.stringify({ ...stats, distinct_games: distinctPairs.length }, null, 2));
  if (dryRun) {
    const byName = new Map(rows.map((b) => [b.sha256, b.name]));
    for (const r of renames) console.error(`rename: ${byName.get(r.sha256)}  ->  ${r.name}`);
    await pool.end();
    return;
  }

  const prune = process.argv.includes("--prune");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await client.query(
      `INSERT INTO games(name, system)
       SELECT * FROM unnest($1::text[], $2::text[])
       ON CONFLICT (name, system) DO NOTHING`,
      [distinctPairs.map((p) => p.game), distinctPairs.map((p) => p.system)]
    );
    // Fill NULL game_id, and re-key assignments whose current game NAME is
    // the wiki-derived one (v1 name-only rows migrate to the (name, system)
    // row); a moderator's different choice stays.
    const assigned = await client.query(
      `UPDATE builds b SET game_id = g.id
       FROM unnest($1::text[], $2::text[], $3::text[]) AS u(sha256, game, system)
       JOIN games g ON g.name = u.game AND g.system = u.system
       WHERE b.sha256 = u.sha256 AND b.game_id IS DISTINCT FROM g.id
         AND (b.game_id IS NULL
              OR EXISTS (SELECT 1 FROM games cur WHERE cur.id = b.game_id AND cur.name = u.game))`,
      [assigns.map((a) => a.sha256), assigns.map((a) => a.game), assigns.map((a) => a.system)]
    );
    await client.query(
      `UPDATE builds b SET name = u.name
       FROM unnest($1::text[], $2::text[]) AS u(sha256, name)
       WHERE b.sha256 = u.sha256`,
      [renames.map((r) => r.sha256), renames.map((r) => r.name)]
    );
    const pruned = prune
      ? (
          await client.query(
            "DELETE FROM games g WHERE NOT EXISTS (SELECT 1 FROM builds WHERE game_id = g.id)"
          )
        ).rowCount
      : 0;
    // Slug backfill for every row still missing one, in id order so the
    // first spelling keeps the base and later near-duplicates get "-<id>".
    const taken = new Set(
      (await client.query("SELECT slug FROM games WHERE slug IS NOT NULL")).rows.map((r) => r.slug as string)
    );
    const bare = (
      await client.query("SELECT id::int AS id, name, system FROM games WHERE slug IS NULL ORDER BY id")
    ).rows as { id: number; name: string; system: string }[];
    const slugged = bare.map((g) => {
      const base = gameSlug(g.name, g.system);
      const slug = taken.has(base) ? `${base}-${g.id}` : base;
      taken.add(slug);
      return { id: g.id, slug };
    });
    await client.query(
      `UPDATE games g SET slug = u.slug
       FROM unnest($1::int[], $2::text[]) AS u(id, slug)
       WHERE g.id = u.id`,
      [slugged.map((s) => s.id), slugged.map((s) => s.slug)]
    );
    await client.query("COMMIT");
    console.log(
      `games created: ${created.rowCount}; game_id set: ${assigned.rowCount}; ` +
        `renamed: ${renames.length}; slugs filled: ${slugged.length}; pruned: ${pruned}`
    );
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
