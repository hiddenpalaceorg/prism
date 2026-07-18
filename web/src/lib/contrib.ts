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
