import { Pool } from "pg";

let pool: Pool | undefined;

/** Lazily-created shared connection pool. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || "postgres:///curator_test",
    });
  }
  return pool;
}
