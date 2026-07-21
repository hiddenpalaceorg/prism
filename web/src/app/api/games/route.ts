import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { searchGames } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/games?q=<term> — game-name suggestions for the moderator combobox
// on the build page. Game names are public metadata (they come from wiki
// articles), so no auth; assignment itself is gated in the PATCH route.
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q") ?? "";
  const games = await searchGames(getPool(), q);
  return Response.json({ games });
}
