import { timingSafeEqual } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { getPool } from "@/lib/db";
import { buildHref } from "@/lib/slug";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// POST /api/refresh { sha256s: [...] } — bust the caches of re-ingested builds:
// each build's ISR page (canonical path, bare-sha redirect, assets subpage),
// its tagged tree cache, and the /builds listing. The moderation endpoints
// revalidate what they touch on their own; this is for scripts/ingest.ts,
// whose record updates otherwise sit behind the hour-long caches.
//
// Gated by REFRESH_TOKEN from the environment (x-refresh-token header) and
// disabled when the variable is unset.
export async function POST(request: Request) {
  const token = process.env.REFRESH_TOKEN;
  if (!token) return Response.json({ error: "not found" }, { status: 404 });
  const given = Buffer.from(request.headers.get("x-refresh-token") ?? "");
  const expected = Buffer.from(token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { sha256s?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "require { sha256s: [...] }" }, { status: 400 });
  }
  const shas = Array.isArray(body.sha256s)
    ? [...new Set(body.sha256s.filter((s): s is string => typeof s === "string" && isSha256(s)))]
    : [];
  if (shas.length === 0) {
    return Response.json({ error: "require { sha256s: [...] }" }, { status: 400 });
  }

  const named = (await getPool().query("SELECT sha256, name FROM builds WHERE sha256 = ANY($1)", [
    shas,
  ])) as { rows: { sha256: string; name: string }[] };

  revalidatePath("/builds");
  for (const { sha256, name } of named.rows) {
    const href = buildHref(sha256, name);
    revalidatePath(href);
    revalidatePath(`${href}/assets`);
    revalidatePath(`/builds/${sha256}`);
    revalidateTag(`build-tree:${sha256}`, "max");
  }
  return Response.json({ refreshed: named.rows.length });
}
