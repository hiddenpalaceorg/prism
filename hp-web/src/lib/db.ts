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
      connectionString: url || "postgres:///prism_test",
      // No page/API query should run longer than this — a runaway query used to
      // pin a Postgres backend at 100% CPU for minutes per request. The bulk
      // ingest CLI builds its own pool and is not capped by this.
      statement_timeout: 15_000,
    });
  }
  return pool;
}
