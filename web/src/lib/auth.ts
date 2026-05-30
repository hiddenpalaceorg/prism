import type { NextRequest } from "next/server";

/** The configured moderation secret, if any (env MODERATION_TOKEN). */
export function moderationToken(): string | undefined {
  return process.env.MODERATION_TOKEN || undefined;
}

/** True when the request carries the matching moderation token. */
export function isModerator(request: NextRequest): boolean {
  const tok = moderationToken();
  return !!tok && request.headers.get("x-moderation-token") === tok;
}
