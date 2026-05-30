import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

/** The configured moderation secret, if any (env MODERATION_TOKEN). */
export function moderationToken(): string | undefined {
  return process.env.MODERATION_TOKEN || undefined;
}

/** Constant-time string compare (avoids timingSafeEqual's unequal-length throw). */
function safeEqual(a: string | null | undefined, b: string): boolean {
  if (a == null) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True when the request carries the matching moderation token. */
export function isModerator(request: NextRequest): boolean {
  const tok = moderationToken();
  return !!tok && safeEqual(request.headers.get("x-moderation-token"), tok);
}
