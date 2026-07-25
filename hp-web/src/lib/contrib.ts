// Contributor auth for the community-metadata routes (media, notes). Any
// logged-in wiki user may contribute to a build they can see; moderators
// (wiki group or shared token) can also touch private builds and other
// people's contributions.

import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import type { Pool } from "pg";
import { getModerator } from "./auth";
import { buildHref } from "./slug";
import { wikiUserFromCookies } from "./wiki-auth";

export interface Contributor {
  /** Wiki username ("token" under shared-secret moderation). */
  name: string;
  moderator: boolean;
}

/** The contributor behind a request, or null (anonymous/invalid session).
 *  Cookie-authenticated mutations must prove same-origin, exactly like the
 *  moderation routes: cookies are ambient, custom headers are not. */
export async function getContributor(request: NextRequest): Promise<Contributor | null> {
  const mod = await getModerator(request);
  if (mod) return { name: mod.name, moderator: true };
  const user = await wikiUserFromCookies(request.headers.get("cookie"));
  if (!user) return null;
  const m = request.method.toUpperCase();
  if (m !== "GET" && m !== "HEAD" && request.headers.get("sec-fetch-site") !== "same-origin") {
    return null;
  }
  return { name: user.name, moderator: false };
}

export interface ContributionTarget {
  name: string;
  visible: boolean;
}

/** Gate a contribute-to-build route: the caller must be a logged-in contributor
 *  and the build must exist and be visible (or the caller a moderator). Returns
 *  the resolved contributor + target, or the error Response to return. Collapses
 *  the 401/404/403 preamble copy-pasted across notes/media-upload routes. */
export async function requireContributor(
  request: NextRequest,
  pool: Pool,
  sha256: string
): Promise<
  | { ok: true; contributor: Contributor; target: ContributionTarget }
  | { ok: false; response: Response }
> {
  const contributor = await getContributor(request);
  if (!contributor) {
    return { ok: false, response: Response.json({ error: "log in to the wiki to contribute" }, { status: 401 }) };
  }
  const target = await contributionTarget(pool, sha256);
  if (!target) {
    return { ok: false, response: Response.json({ error: "not found" }, { status: 404 }) };
  }
  if (!target.visible && !contributor.moderator) {
    return { ok: false, response: Response.json({ error: "this build is not open for contributions" }, { status: 403 }) };
  }
  return { ok: true, contributor, target };
}

/** The build a contribution targets: its display name (for revalidation) and
 *  whether the public can see it, or null when it doesn't exist. Writes to a
 *  hidden build require a moderator. */
export async function contributionTarget(pool: Pool, sha256: string): Promise<ContributionTarget | null> {
  const r = await pool.query(
    `SELECT name, NOT (private OR EXISTS (SELECT 1 FROM private_lots _pl WHERE _pl.lot = builds.lot)) AS visible
     FROM builds WHERE sha256=$1`,
    [sha256]
  );
  return (r.rows[0] as ContributionTarget) ?? null;
}

/** Surface a contribution on the ISR-cached build page right away. */
export function revalidateBuildPages(sha256: string, name: string): void {
  revalidatePath(buildHref(sha256, name));
  revalidatePath(`/builds/${sha256}`);
}
