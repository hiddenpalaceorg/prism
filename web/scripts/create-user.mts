// Create a local cube wiki account:
//   npx tsx web/scripts/create-user.mts <name> <password> [role,...]

import pg from "pg";
import { createUser } from "cube";

const [name, password, roles] = process.argv.slice(2);
if (!name || !password) {
  console.error("usage: create-user.mts <name> <password> [role,...]");
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
