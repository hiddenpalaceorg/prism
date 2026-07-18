import fsp from "node:fs/promises";
import type { NextRequest } from "next/server";
import { storeBlobFromFile } from "@/lib/blobstore";
import { getContributor, contributionTarget, revalidateBuildPages } from "@/lib/contrib";
import { getPool } from "@/lib/db";
import { extractStill } from "@/lib/ffmpeg";
import {
  MEDIA_NS,
  dropMediaSession,
  hashFile,
  insertMedia,
  isMediaToken,
  mediaStagingPath,
  mediaView,
  readMediaSession,
  sniffMedia,
  updateMediaSession,
} from "@/lib/media";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Client chunks stay well under proxy body limits; reject anything absurd.
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

// PUT /api/build/<sha256>/media/upload/<token>?offset=N: append one chunk to
// an open upload session. The first chunk is sniffed (magic bytes decide the
// stored content type; the client's claim is ignored) and must agree with the
// session's kind. A stale offset answers 409 { offset } so the client can
// resume. When the staged bytes reach the claimed size the file is hashed,
// stored under the media/ namespace (with a poster still for videos), and
// recorded; the response carries { done: true, media }.
export async function PUT(
  request: NextRequest,
  ctx: { params: Promise<{ sha256: string; token: string }> }
) {
  const { sha256, token } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  if (!isMediaToken(token)) return Response.json({ error: "invalid token" }, { status: 400 });

  const contributor = await getContributor(request);
  if (!contributor) {
    return Response.json({ error: "log in to the wiki to contribute" }, { status: 401 });
  }
  const pool = getPool();
  const target = await contributionTarget(pool, sha256);
  if (!target) return Response.json({ error: "not found" }, { status: 404 });
  if (!target.visible && !contributor.moderator) {
    return Response.json({ error: "this build is not open for contributions" }, { status: 403 });
  }

  const session = await readMediaSession(token);
  if (!session || session.build !== sha256) {
    return Response.json({ error: "no such upload session" }, { status: 404 });
  }
  const staging = mediaStagingPath(token);
  const st = await fsp.stat(staging).catch(() => null);
  if (!st) return Response.json({ error: "no such upload session" }, { status: 404 });
  let staged = st.size;
  if (staged > session.size) {
    await dropMediaSession(token);
    return Response.json({ error: "corrupt upload session" }, { status: 400 });
  }

  if (staged < session.size) {
    const offset = Number(request.nextUrl.searchParams.get("offset") ?? "0");
    if (!Number.isInteger(offset) || offset < 0) {
      return Response.json({ error: "invalid offset" }, { status: 400 });
    }
    if (offset !== staged) return Response.json({ offset: staged }, { status: 409 });

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_CHUNK_BYTES) {
      return Response.json({ error: "chunk too large" }, { status: 413 });
    }
    const chunk = Buffer.from(await request.arrayBuffer());
    if (!chunk.length) return Response.json({ error: "empty chunk" }, { status: 400 });
    if (chunk.length > MAX_CHUNK_BYTES) {
      return Response.json({ error: "chunk too large" }, { status: 413 });
    }
    if (staged + chunk.length > session.size) {
      return Response.json({ error: "chunk exceeds the claimed size" }, { status: 400 });
    }

    if (staged === 0) {
      const sniffed = sniffMedia(chunk);
      if (!sniffed) {
        await dropMediaSession(token);
        return Response.json(
          { error: "unsupported format (png, jpeg, gif, webp, mp4, or webm)" },
          { status: 415 }
        );
      }
      if (sniffed.video !== (session.kind === "video")) {
        await dropMediaSession(token);
        return Response.json(
          {
            error: sniffed.video
              ? "that file is a video, upload it as the video kind"
              : `${session.kind} uploads must be images`,
          },
          { status: 415 }
        );
      }
      session.contentType = sniffed.contentType;
      await updateMediaSession(token, session);
    }

    await fsp.appendFile(staging, chunk);
    staged = (await fsp.stat(staging)).size;
    if (staged < session.size) return Response.json({ done: false, offset: staged });
    if (staged > session.size) {
      await dropMediaSession(token);
      return Response.json({ error: "corrupt upload session" }, { status: 400 });
    }
  }

  // Complete (possibly a retry after a failed finalize): hash, store, record.
  if (!session.contentType) {
    await dropMediaSession(token);
    return Response.json({ error: "corrupt upload session" }, { status: 400 });
  }
  const blobSha = await hashFile(staging);

  let poster: string | null = null;
  if (session.contentType.startsWith("video/")) {
    const posterTmp = `${staging}.poster.jpg`;
    try {
      await extractStill(staging, posterTmp);
      poster = await hashFile(posterTmp);
      await storeBlobFromFile(poster, posterTmp, { ns: MEDIA_NS });
    } catch {
      // No usable ffmpeg or no decodable frame: the video plays without one.
      await fsp.rm(posterTmp, { force: true });
      poster = null;
    }
  }

  await storeBlobFromFile(blobSha, staging, { ns: MEDIA_NS });
  await dropMediaSession(token);

  const row = await insertMedia(pool, {
    build_sha256: sha256,
    kind: session.kind,
    sha256: blobSha,
    poster_sha256: poster,
    filename: session.filename,
    content_type: session.contentType,
    size: session.size,
    author: session.author,
  });
  revalidateBuildPages(sha256, target.name);
  return Response.json({ done: true, media: mediaView(row) });
}
