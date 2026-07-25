// Drain the cube git-export queue into a local mirror repo.
//   npx tsx web/scripts/git-export.mts [--dir <path>]

import pg from "pg";
import { processGitQueue } from "cube";

const dirFlag = process.argv.indexOf("--dir");
const dir = dirFlag > 0 ? process.argv[dirFlag + 1]! : new URL("../.wiki-git", import.meta.url).pathname;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgres:///curator" });
const result = await processGitQueue(pool, { dir, emailDomain: "users.hiddenpalace.org" });
console.log(`processed ${result.processed} queue items into ${dir}`);
if (result.itemError) console.error(`stopped at item ${result.itemError.queueId}: ${result.itemError.message}`);
if (result.pushError) console.error(`push failed: ${result.pushError}`);
await pool.end();
