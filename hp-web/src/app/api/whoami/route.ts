import type { NextRequest } from "next/server";
import { getModerator } from "@/lib/auth";
import { wikiUserFromCookies } from "@/lib/wiki-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/whoami — the visitor's moderation identity, from the shared token
// header or the wiki session cookies riding along on this same-origin request.
// A wiki user outside the moderator groups still gets their name back so the
// UI can explain why moderation stays hidden.
export async function GET(request: NextRequest) {
  const mod = await getModerator(request);
  if (mod) {
    return Response.json({ moderator: true, name: mod.name, via: mod.via });
  }
  const user = await wikiUserFromCookies(request.headers.get("cookie"));
  if (user) {
    return Response.json({ moderator: false, name: user.name, via: "wiki" });
  }
  return Response.json({ moderator: false });
}
