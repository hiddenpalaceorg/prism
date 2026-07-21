// Import per-build game classification from the Hidden Palace wiki mapping
// dumps:
//   wiki-map.json    articles <-> download files (sha1/url/size per download)
//   wiki-proto.json  article -> {{Prototype}} infobox fields (game, ...)
// Usage: npm run import-wiki-games -- --map wiki-map.json --proto wiki-proto.json [--dry-run]
//        (env DATABASE_URL)
//
// Joins builds to wiki downloads by archive sha1, then per matched build:
//  - upserts the infobox "game" into games and sets builds.game_id — only
//    when game_id is NULL, so re-runs never clobber a moderator's assignment;
//  - renames the build to the article's as-typed File title (underscores and
//    spaces are interchangeable in MediaWiki titles, so the imported
//    underscored disk name is "supposed to be" the spaced title). A build
//    whose name no longer corresponds to its wiki file — i.e. a moderator
//    renamed it — is left alone. Game names are imported verbatim: infobox
//    text keeps intentional underscores (WATCH_DOGS), unlike file names.
// --underscore-unmatched additionally rewrites _ to space in the name of
// every build whose sha1 is NOT in the map — only safe when every such build
// is known to carry a pristine wiki filename (e.g. curator_wiki, or strays
// whose wiki download was replaced after the dump was taken).

import fs from "node:fs";
import pg from "pg";
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
  const assigns: { sha256: string; game: string }[] = [];
  const stats = {
    builds: rows.length,
    matched: 0,
    renamed: 0,
    game_set: 0,
    game_already_set: 0,
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

    const games = new Set(
      [...e.articles]
        .map((a) => proto.articles[a]?.prototype?.game?.trim())
        .filter((g): g is string => !!g)
    );
    if (b.game_id != null) {
      stats.game_already_set++;
    } else if (games.size === 1) {
      assigns.push({ sha256: b.sha256, game: [...games][0] });
      stats.game_set++;
    } else if (games.size > 1) {
      stats.ambiguous_game++;
      console.error(`ambiguous game for ${b.name} (${b.sha256.slice(0, 12)}): ${[...games].join(" | ")}`);
    } else {
      stats.no_infobox_game++;
    }
  }

  const gameNames = [...new Set(assigns.map((a) => a.game))].sort();
  console.log(JSON.stringify({ ...stats, distinct_games: gameNames.length }, null, 2));
  if (dryRun) {
    const byName = new Map(rows.map((b) => [b.sha256, b.name]));
    for (const r of renames) console.error(`rename: ${byName.get(r.sha256)}  ->  ${r.name}`);
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await client.query(
      "INSERT INTO games(name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING",
      [gameNames]
    );
    await client.query(
      `UPDATE builds b SET game_id = g.id
       FROM unnest($1::text[], $2::text[]) AS u(sha256, game)
       JOIN games g ON g.name = u.game
       WHERE b.sha256 = u.sha256 AND b.game_id IS NULL`,
      [assigns.map((a) => a.sha256), assigns.map((a) => a.game)]
    );
    await client.query(
      `UPDATE builds b SET name = u.name
       FROM unnest($1::text[], $2::text[]) AS u(sha256, name)
       WHERE b.sha256 = u.sha256`,
      [renames.map((r) => r.sha256), renames.map((r) => r.name)]
    );
    await client.query("COMMIT");
    console.log(`games created: ${created.rowCount}; game_id set: ${assigns.length}; renamed: ${renames.length}`);
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
