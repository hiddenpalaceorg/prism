import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";

/** A wiki account resolved from the incoming request's session cookies. */
export interface WikiUser {
  id: number;
  name: string;
  groups: string[];
}

/** Base URL of the MediaWiki api.php (env WIKI_API_URL); unset disables wiki login. */
export function wikiApiUrl(): string | undefined {
  return process.env.WIKI_API_URL || undefined;
}

/** Wiki groups whose members may moderate (env MODERATION_WIKI_GROUPS, comma-separated). */
export function moderatorGroups(): string[] {
  return (process.env.MODERATION_WIKI_GROUPS ?? "sysop")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function cookiePrefix(): string {
  return process.env.WIKI_COOKIE_PREFIX ?? "hp_wiki_new";
}

// The app shares the hiddenpalace.org origin with the wiki, whose session
// cookies are set with path=/, so they ride along on every request to us.
// A session is validated by forwarding the cookies to the wiki's own
// userinfo API; verdicts are cached briefly so page loads don't hammer it.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expires: number; user: WikiUser | null }>();

/** Resolve the wiki user behind a Cookie header, or null (anon/invalid/disabled). */
export async function wikiUserFromCookies(cookieHeader: string | null): Promise<WikiUser | null> {
  const api = wikiApiUrl();
  if (!api || !cookieHeader) return null;
  // Skip the API round-trip unless a wiki session or remember-me cookie is present.
  const prefix = cookiePrefix();
  if (!cookieHeader.includes(`${prefix}_session=`) && !cookieHeader.includes(`${prefix}Token=`)) {
    return null;
  }

  const key = createHash("sha256").update(cookieHeader).digest("base64");
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.user;
  if (cache.size > 1000) {
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  }

  const user = await queryUserinfo(api, cookieHeader);
  cache.set(key, { expires: now + CACHE_TTL_MS, user });
  return user;
}

// node:http rather than fetch: undici strips custom Host headers, and
// WIKI_API_HOST needs one (on the server the wiki is reached by IP without
// leaving the box, with the vhost picked by Host).
function queryUserinfo(api: string, cookieHeader: string): Promise<WikiUser | null> {
  const url = new URL(api);
  url.search = new URLSearchParams({
    action: "query",
    meta: "userinfo",
    uiprop: "groups",
    format: "json",
  }).toString();
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const req = request(
      url,
      {
        headers: {
          Cookie: cookieHeader,
          ...(process.env.WIKI_API_HOST ? { Host: process.env.WIKI_API_HOST } : {}),
        },
        timeout: 4000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const info = JSON.parse(body)?.query?.userinfo;
            resolve(
              info && info.id > 0
                ? { id: info.id, name: info.name, groups: info.groups ?? [] }
                : null,
            );
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(null));
    req.end();
  });
}
