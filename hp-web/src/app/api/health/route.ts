import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health: what the :6800 front door, the deploy swap and the
// watchdog cron ask before they trust an app slot. The database round trip is
// the point: `/` renders fine with Postgres down, so a slot that cannot reach
// it has to fail this check rather than keep taking a share of the traffic.

// The build this process serves, so a rolling deploy can be watched landing
// one slot at a time. Read once, since a running server never changes build.
let buildId: Promise<string | null> | undefined;

function readBuildId(): Promise<string | null> {
  buildId ??= readFile(join(process.cwd(), process.env.NEXT_DIST_DIR || ".next", "BUILD_ID"), "utf8")
    .then((s) => s.trim())
    .catch(() => null);
  return buildId;
}

// Long enough to ride out a busy pool, short enough that a wedged database
// fails the check instead of hanging the caller that is deciding whether to
// take this slot out of rotation.
const DB_TIMEOUT_MS = 5_000;

async function dbUp(): Promise<boolean> {
  try {
    await Promise.race([
      getPool().query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("db timeout")), DB_TIMEOUT_MS)),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const [build, db] = await Promise.all([readBuildId(), dbUp()]);
  return Response.json(
    { ok: db, slot: process.env.APP_SLOT ?? null, build, db: db ? "up" : "down" },
    { status: db ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  );
}
