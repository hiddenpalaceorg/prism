import { Pool } from "pg";

let pool: Pool | undefined;

/** Lazily-created shared connection pool. */
export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url && process.env.NODE_ENV === "production") {
      throw new Error("DATABASE_URL must be set in production");
    }
    pool = new Pool({
      connectionString: url || "postgres:///curator_test",
    });
  }
  return pool;
}
