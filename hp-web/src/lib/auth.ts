import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { wikiUserFromCookies, moderatorGroups, wikiApiUrl } from "@/lib/wiki-auth";

/** The configured moderation secret, if any (env MODERATION_TOKEN). */
export function moderationToken(): string | undefined {
  return process.env.MODERATION_TOKEN || undefined;
}

/** True when some moderation credential is configured (shared token or wiki login). */
export function moderationEnabled(): boolean {
  return !!moderationToken() || !!wikiApiUrl();
}

/** Constant-time string compare (avoids timingSafeEqual's unequal-length throw). */
export function safeEqual(a: string | null | undefined, b: string): boolean {
  if (a == null) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface Moderator {
  /** Wiki username, or "token" for shared-secret auth. */
  name: string;
  via: "token" | "wiki";
}

/**
 * The moderator identity attached to a request, or null. Two credentials work:
 *  - the shared x-moderation-token header;
 *  - a hiddenpalace.org wiki session (same-origin cookies) whose user is in a
 *    moderator group (MODERATION_WIKI_GROUPS).
 * Cookies are ambient, so mutating requests authenticated by them must also
 * prove same-origin via Sec-Fetch-Site. The token header needs no such proof:
 * cross-site pages cannot attach custom headers.
 */
export async function getModerator(request: NextRequest): Promise<Moderator | null> {
  return getModeratorFromHeaders(request.headers, request.method);
}

/** Header-based variant for server components (via next/headers), where no
 *  NextRequest exists. Pages render on GET, so the CSRF gate never bites there. */
export async function getModeratorFromHeaders(h: Headers, method = "GET"): Promise<Moderator | null> {
  const tok = moderationToken();
  if (tok && safeEqual(h.get("x-moderation-token"), tok)) {
    return { name: "token", via: "token" };
  }
  const user = await wikiUserFromCookies(h.get("cookie"));
  if (!user) return null;
  if (!moderatorGroups().some((g) => user.groups.includes(g))) return null;
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD" && h.get("sec-fetch-site") !== "same-origin") {
    return null;
  }
  return { name: user.name, via: "wiki" };
}

/** Gate a moderator-only route: null when the caller is a moderator, else the
 *  error Response to return (401 when moderation is configured, 403 when it's
 *  disabled entirely). Collapses the guard copy-pasted across the mod routes. */
export async function requireModerator(request: NextRequest): Promise<Response | null> {
  if (await getModerator(request)) return null;
  return moderationEnabled()
    ? Response.json({ error: "unauthorized" }, { status: 401 })
    : Response.json(
        { error: "moderation disabled (set MODERATION_TOKEN or WIKI_API_URL)" },
        { status: 403 }
      );
}
