import { readFile } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import { ImageResponse } from "next/og";
import { readBlob } from "@/lib/blobstore";
import { diffRows, type DiffRow } from "@/lib/linediff";
import { loadRepo, repoAttached } from "@/lib/repo";
import {
  commitChanges,
  commitSubject,
  entryAt,
  formatCommitDate,
  resolveRev,
  shortOid,
  type RepoCommit,
  type RepoIndex,
  type TreeChange,
} from "@/lib/repo-manifest";
import { normalizeAssetPath } from "@/lib/slug";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/repo/<manifest sha256>/og?rev=&path=&diff= — social-preview card
// (og:image) for the repo viewer, rendered with satori via next/og. The
// viewer's state lives in query params, which Next's opengraph-image file
// convention can't see, so this is a plain route the page's generateMetadata
// points og:image at. Variants mirror the viewer: a diff link renders a
// side-by-side red/green snippet, a file link its opening lines, the root a
// repo card. Immutable per URL (content-addressed manifest).
const CACHE = "public, max-age=31536000, immutable";
const WIDTH = 1200;
const HEIGHT = 630;

// Snippet shape: enough rows to look like a diff, short enough to stay legible.
const SNIPPET_ROWS = 11;
const HALF_COLS = 38; // chars per diff half at fontSize 19
const FULL_COLS = 84; // chars for single-column snippets
const MAX_SNIPPET_BLOB = 2_000_000;

// satori needs raw font data; JetBrains Mono (OFL, src/lib/fonts) everywhere
// keeps the card reading as code.
let fontsLoaded: Promise<{ regular: Buffer; bold: Buffer }> | null = null;
function fonts() {
  fontsLoaded ??= (async () => {
    const dir = path.join(process.cwd(), "src", "lib", "fonts");
    const [regular, bold] = await Promise.all([
      readFile(path.join(dir, "JetBrainsMono-Regular.ttf")),
      readFile(path.join(dir, "JetBrainsMono-Bold.ttf")),
    ]);
    return { regular, bold };
  })();
  return fontsLoaded;
}

const clean = (s: string, cols: number) => s.replace(/\t/g, "  ").replace(/\r/g, "").slice(0, cols);
const basename = (p: string) => p.split("/").pop() || p;

/** A text blob's content, or null when it's binary/oversized/missing. */
async function blobText(idx: RepoIndex, oid: string | null): Promise<string | null> {
  if (!oid) return "";
  const info = idx.blobs.get(oid);
  if (!info || info[2] === 1 || info[1] > MAX_SNIPPET_BLOB) return null;
  try {
    return (await readBlob(info[0]))?.toString("utf8") ?? null;
  } catch {
    return null;
  }
}

/** The first window of rows around a change. */
function snippetWindow(rows: DiffRow[]): DiffRow[] {
  const first = rows.findIndex((r) => r.changed);
  const start = Math.max(0, (first === -1 ? 0 : first) - 2);
  return rows.slice(start, start + SNIPPET_ROWS);
}

// ── satori building blocks (flexbox only, single mono family) ─────────────────

function Chip({ text, color = "#d4d4d4" }: { text: string; color?: string }) {
  return (
    <div
      style={{
        border: "1px solid #333333",
        borderRadius: 10,
        padding: "6px 18px",
        fontSize: 24,
        color,
        display: "flex",
      }}
    >
      {text}
    </div>
  );
}

function Card({
  title,
  context,
  chips,
  children,
}: {
  title: string;
  context: string;
  chips?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#0a0a0a",
        color: "#fafafa",
        padding: 44,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 22, letterSpacing: 6, color: "#737373" }}>HIDDEN PALACE · SOURCE</div>
        {chips ?? <div style={{ display: "flex" }} />}
      </div>
      <div
        style={{
          marginTop: 18,
          fontSize: 44,
          fontWeight: 700,
          lineHeight: 1.15,
          display: "block",
          lineClamp: 1,
        }}
      >
        {title}
      </div>
      <div style={{ marginTop: 10, fontSize: 24, color: "#737373", display: "block", lineClamp: 1 }}>
        {context}
      </div>
      <div
        style={{
          marginTop: 22,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          background: "#141414",
          border: "1px solid #262626",
          borderRadius: 14,
          padding: 20,
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function HalfCell({ cell, changed, side }: { cell: DiffRow["l"]; changed: boolean; side: "l" | "r" }) {
  const bg = !changed ? "transparent" : cell === null ? "#1c1c1c" : side === "l" ? "#3b161d" : "#12301c";
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", backgroundColor: bg, overflow: "hidden" }}>
      <div style={{ width: 58, paddingRight: 14, fontSize: 19, color: "#6e7681", justifyContent: "flex-end", display: "flex", flexShrink: 0 }}>
        {cell ? String(cell.n) : ""}
      </div>
      <div style={{ fontSize: 19, whiteSpace: "pre", color: changed ? "#e6edf3" : "#a3a3a3", display: "flex" }}>
        {cell ? clean(cell.s, HALF_COLS) : ""}
      </div>
    </div>
  );
}

function DiffSnippet({ rows }: { rows: DiffRow[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", height: 34, alignItems: "center", gap: 18 }}>
          <HalfCell cell={r.l} changed={r.changed} side="l" />
          <HalfCell cell={r.r} changed={r.changed} side="r" />
        </div>
      ))}
    </div>
  );
}

function CodeSnippet({ lines, start }: { lines: string[]; start: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {lines.map((s, i) => (
        <div key={i} style={{ display: "flex", height: 34, alignItems: "center" }}>
          <div style={{ width: 58, paddingRight: 14, fontSize: 19, color: "#6e7681", justifyContent: "flex-end", display: "flex" }}>
            {String(start + i)}
          </div>
          <div style={{ fontSize: 19, whiteSpace: "pre", color: "#d4d4d4", display: "flex" }}>{clean(s, FULL_COLS)}</div>
        </div>
      ))}
    </div>
  );
}

function statChips(rows: DiffRow[]): React.ReactNode {
  const adds = rows.filter((r) => r.changed && r.r).length;
  const dels = rows.filter((r) => r.changed && r.l).length;
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <Chip text={`+${adds}`} color="#3fb950" />
      <Chip text={`-${dels}`} color="#f85149" />
    </div>
  );
}

// ── variants ──────────────────────────────────────────────────────────────────

async function diffCard(
  idx: RepoIndex,
  name: string,
  commit: RepoCommit,
  changes: TreeChange[],
  wantPath: string | null
): Promise<React.ReactElement> {
  const when = `${commit.author.name} · ${formatCommitDate(commit.author)}`;
  // The named file when the link carries one, else the first diffable change.
  let pick = wantPath ? changes.find((c) => c.path === wantPath) : undefined;
  let pair: { before: string; after: string } | null = null;
  for (const candidate of pick ? [pick] : changes) {
    const before = await blobText(idx, candidate.from);
    const after = await blobText(idx, candidate.to);
    if (before !== null && after !== null) {
      pick = candidate;
      pair = { before, after };
      break;
    }
    if (wantPath) break; // the named file isn't diffable — no snippet
  }
  const rows = pair ? diffRows(pair.before, pair.after) : [];
  const title = wantPath ? basename(wantPath) : commitSubject(commit.message) || shortOid(commit.oid);
  const context = wantPath
    ? `${commitSubject(commit.message) || shortOid(commit.oid)} · ${when}`
    : `${name} · ${changes.length} file${changes.length === 1 ? "" : "s"} changed · ${when}`;
  return (
    <Card title={title} context={context} chips={rows.length ? statChips(rows) : undefined}>
      {pair ? (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {!wantPath && pick && (
            <div style={{ fontSize: 20, color: "#737373", marginBottom: 10, display: "block", lineClamp: 1 }}>
              {pick.path}
            </div>
          )}
          <DiffSnippet rows={snippetWindow(rows)} />
        </div>
      ) : (
        <div style={{ fontSize: 24, color: "#737373" }}>No text diff for this change.</div>
      )}
    </Card>
  );
}

async function fileCard(
  idx: RepoIndex,
  name: string,
  revOid: string,
  filePath: string
): Promise<React.ReactElement> {
  const entry = entryAt(idx, revOid, filePath);
  const text = entry?.type === "blob" ? await blobText(idx, entry.oid) : null;
  const lines = text !== null ? text.split("\n").slice(0, SNIPPET_ROWS + 1) : null;
  return (
    <Card title={basename(filePath)} context={`${filePath} · ${name} · ${shortOid(revOid)}`}>
      {lines ? (
        <CodeSnippet lines={lines} start={1} />
      ) : (
        <div style={{ fontSize: 24, color: "#737373" }}>No preview for this file.</div>
      )}
    </Card>
  );
}

function repoCard(idx: RepoIndex, name: string): React.ReactElement {
  const m = idx.manifest;
  const recent = m.commits.slice(0, SNIPPET_ROWS);
  return (
    <Card
      title={name}
      context="source repository · hiddenpalace.org"
      chips={
        <div style={{ display: "flex", gap: 12 }}>
          <Chip text={`${m.commits.length} commits`} />
          <Chip text={m.headRef ?? shortOid(m.head)} />
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        {recent.map((c) => (
          <div key={c.oid} style={{ display: "flex", height: 34, alignItems: "center", gap: 18 }}>
            <div style={{ fontSize: 19, color: "#6e7681", display: "flex" }}>
              {formatCommitDate(c.author).slice(0, 10)}
            </div>
            <div style={{ fontSize: 19, color: "#d4d4d4", whiteSpace: "pre", display: "flex" }}>
              {clean(commitSubject(c.message) || "(no message)", 70)}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── route ─────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return new Response("not found", { status: 404 });
  if (!(await repoAttached(sha256))) return new Response("not found", { status: 404 });
  const idx = await loadRepo(sha256);
  if (!idx) return new Response("not found", { status: 404 });

  const params = request.nextUrl.searchParams;
  const revOid = resolveRev(idx, params.get("rev") ?? "") ?? idx.manifest.head;
  const filePath = normalizeAssetPath(params.get("path") ?? "") || null;
  const diffParam = (params.get("diff") ?? "").toLowerCase();
  const name = idx.manifest.name;

  let card: React.ReactElement | null = null;
  if (diffParam) {
    const commitOid = resolveRev(idx, diffParam);
    const commit = commitOid ? idx.commitByOid.get(commitOid) : undefined;
    if (commit) card = await diffCard(idx, name, commit, commitChanges(idx, commit.oid), filePath);
  }
  if (!card && filePath) card = await fileCard(idx, name, revOid, filePath);
  if (!card) card = repoCard(idx, name);

  const { regular, bold } = await fonts();
  // Materialize so a satori failure degrades to the plain repo card instead of
  // a broken unfurl.
  const options = {
    width: WIDTH,
    height: HEIGHT,
    fonts: [
      { name: "JetBrains Mono", data: regular, weight: 400 as const },
      { name: "JetBrains Mono", data: bold, weight: 700 as const },
    ],
  };
  try {
    const buf = await new ImageResponse(card, options).arrayBuffer();
    return new Response(buf, { headers: { "Content-Type": "image/png", "Cache-Control": CACHE } });
  } catch {
    const buf = await new ImageResponse(repoCard(idx, name), options).arrayBuffer();
    return new Response(buf, { headers: { "Content-Type": "image/png", "Cache-Control": CACHE } });
  }
}
