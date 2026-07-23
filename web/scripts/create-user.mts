// Create a local cube wiki account:
//   CUBE_PASSWORD=... npx tsx web/scripts/create-user.mts <name> [role,...]
// The password comes from $CUBE_PASSWORD (or an stdin prompt) so it never lands
// in the process table (ps) or shell history the way an argv password would.

import { createInterface } from "node:readline/promises";
import pg from "pg";
import { createUser } from "cube";

const [name, roles] = process.argv.slice(2);
if (!name) {
  console.error("usage: CUBE_PASSWORD=<pw> create-user.mts <name> [role,...]");
  process.exit(2);
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.CUBE_PASSWORD;
  if (fromEnv) return fromEnv;
  // Only prompt on a real terminal; a piped/closed stdin returns "" and the
  // caller exits cleanly rather than hanging on an EOF that never resolves.
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question("password: ");
  } finally {
    rl.close();
  }
}

const password = await readPassword();
if (!password) {
  console.error("a password is required (set CUBE_PASSWORD or type one at the prompt)");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgres:///curator" });
const user = await createUser(pool, {
  name,
  password,
  roles: roles ? roles.split(",") : [],
});
console.log(`created user ${user.name} (id ${user.id}) roles=[${user.roles.join(", ")}]`);
await pool.end();
