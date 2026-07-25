/**
 * Hidden Palace server bindings for the cube components in schemas.ts.
 * Loaders do all data fetching (media resolution, object queries, hrefs) and
 * return plain JSON; Views are client-safe presentational functions.
 */

import { Fragment, type ReactNode } from "react";
import { DEFAULT_SLUG_CONFIG, isTitleError, normalizeTitle, type QueryRow } from "cube";
import type { ComponentBinding, ComponentViewProps, CubeRenderCtx } from "cube/react";

/* ---- shared helpers ------------------------------------------------------ */

type PageLink = {
  href: string;
  title: string;
  displayTitle: string | null;
};

function toLink(ctx: CubeRenderCtx, row: QueryRow): PageLink {
  return {
    href: ctx.pageHref(row.page),
    title: row.page.title,
    displayTitle: row.page.displayTitle,
  };
}

async function resolveMediaUrl(ctx: CubeRenderCtx, name: unknown): Promise<string | null> {
  if (typeof name !== "string" || name === "" || !ctx.resolveMedia) return null;
  const map = await ctx.resolveMedia([name]);
  return map.get(name) ?? null;
}

/** Page-authored json attrs and json children arrive unvalidated from the
 *  core, so anything rendered out of them is coerced through these first. */
function text(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function int(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function humanSize(bytes: unknown): string | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(mib / 1024).toFixed(2)} GiB`;
}

function Row({ label, value }: { label: string; value?: ReactNode }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className="flex gap-2 border-t border-neutral-200 px-2 py-1 dark:border-neutral-800">
      <div className="w-24 shrink-0 font-semibold">{label}</div>
      <div className="min-w-0 break-words">{value}</div>
    </div>
  );
}

function Infobox({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <aside className="float-right clear-right mb-4 ml-4 w-64 rounded border border-neutral-300 bg-neutral-50 text-sm dark:border-neutral-700 dark:bg-neutral-900">
      <div className="px-2 py-1.5 text-center font-bold">{title}</div>
      {children}
    </aside>
  );
}

function SectionHead({ children }: { children: ReactNode }) {
  return (
    <div className="border-t border-neutral-300 bg-neutral-100 px-2 py-1 text-center font-semibold dark:border-neutral-700 dark:bg-neutral-800">
      {children}
    </div>
  );
}

function LinkList({ links }: { links: PageLink[] }) {
  return (
    <ul className="list-disc pl-5">
      {links.map((l) => (
        <li key={l.href}>
          <a href={l.href} className="hover:underline">
            {l.displayTitle ?? l.title}
          </a>
        </li>
      ))}
    </ul>
  );
}

/* ---- inline wikitext in string attrs ------------------------------------- */

// Imported infobox params carry MediaWiki inline markup inside plain string
// attrs - "[[171-5694-01]]" for a board cross-reference, "<br>" between owners.
// Rendered as React text children those show up as literal brackets and tags,
// so the loader turns them into segments (plain JSON, per this module's
// loader/View split) and RichText draws them.

type RichSeg =
  | { t: "text"; v: string }
  | { t: "br" }
  | { t: "link"; v: string; href: string; exists: boolean };

type RichToken =
  | { t: "text"; v: string }
  | { t: "br" }
  | { t: "link"; target: string; label: string };

const INLINE_WIKITEXT = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|<br\s*\/?>/gi;

function hasInlineWikitext(v: unknown): v is string {
  return typeof v === "string" && (v.includes("[[") || /<br\s*\/?>/i.test(v));
}

function tokenizeWikitext(src: string): RichToken[] {
  const out: RichToken[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE_WIKITEXT)) {
    const at = m.index;
    if (at > last) out.push({ t: "text", v: src.slice(last, at) });
    if (m[1] === undefined) {
      out.push({ t: "br" });
    } else {
      const target = m[1].trim();
      const label = (m[2] ?? "").trim();
      out.push({ t: "link", target, label: label === "" ? target : label });
    }
    last = at + m[0].length;
  }
  if (last < src.length) out.push({ t: "text", v: src.slice(last) });
  return out;
}

/** Segment the named string attrs, resolving every wikilink in one batch.
 *  Attrs with no inline markup are omitted; the View falls back to the raw
 *  string, which is already correct for them. */
async function richAttrs(
  ctx: CubeRenderCtx,
  attrs: Record<string, unknown>,
  keys: readonly string[],
): Promise<Record<string, RichSeg[]>> {
  const tokens = new Map<string, RichToken[]>();
  for (const key of keys) {
    const v = attrs[key];
    if (hasInlineWikitext(v)) tokens.set(key, tokenizeWikitext(v));
  }
  if (tokens.size === 0) return {};

  const slugCfg = ctx.slug ?? DEFAULT_SLUG_CONFIG;
  const refs = new Map<string, { ns: string; slug: string }>();
  for (const toks of tokens.values()) {
    for (const t of toks) {
      if (t.t !== "link" || refs.has(t.target)) continue;
      const ref = normalizeTitle(t.target, slugCfg);
      if (!isTitleError(ref)) refs.set(t.target, { ns: ref.ns, slug: ref.slug });
    }
  }
  const existing =
    ctx.resolveLinks && refs.size > 0
      ? await ctx.resolveLinks([...refs.values()])
      : new Map<string, boolean>();

  const out: Record<string, RichSeg[]> = {};
  for (const [key, toks] of tokens) {
    out[key] = toks.map((t): RichSeg => {
      if (t.t === "br") return { t: "br" };
      if (t.t === "text") return { t: "text", v: t.v };
      const ref = refs.get(t.target);
      // An unparseable target keeps its label as prose rather than a dead link.
      if (!ref) return { t: "text", v: t.label };
      return {
        t: "link",
        v: t.label,
        href: ctx.pageHref(ref),
        exists: existing.get(`${ref.ns}:${ref.slug}`) ?? true,
      };
    });
  }
  return out;
}

function RichText({ segs }: { segs: RichSeg[] }) {
  return (
    <>
      {segs.map((seg, i) => {
        if (seg.t === "br") return <br key={i} />;
        if (seg.t === "text") return <Fragment key={i}>{seg.v}</Fragment>;
        return (
          <a key={i} href={seg.href} className={seg.exists ? "hover:underline" : "cube-redlink"}>
            {seg.v}
          </a>
        );
      })}
    </>
  );
}

/** Row value: the segmented form when the loader produced one, else the raw
 *  string. */
function rich(map: Record<string, RichSeg[]> | undefined, key: string, raw?: string) {
  const segs = map?.[key];
  return segs ? <RichText segs={segs} /> : raw;
}

/* ---- Prototype ----------------------------------------------------------- */

/** Prose attrs that carry imported inline wikitext (board/lot cross-references
 *  and <br> separated ownership history). */
const PROTOTYPE_RICH = [
  "originType", "originLot", "originEproms", "originBoard", "originDiscType",
  "originDevKit", "originLabels", "originFiles", "originDumpMethod", "originOwnership",
] as const;

type PrototypeData = {
  titleScreenUrl: string | null;
  rich: Record<string, RichSeg[]>;
};

function PrototypeView({ attrs, data }: ComponentViewProps) {
  const a = attrs as {
    titleScreen?: string;
    buildDate?: string;
    buildName?: string;
    status?: string;
    datStatus?: string;
    dumpedBy?: string[];
    releasedBy?: string[];
    fileDumpDate?: string;
    fileReleaseDate?: string;
    originType?: string;
    originLot?: string;
    originEproms?: string;
    originBoard?: string;
    originDiscType?: string;
    originDevKit?: string;
    originLabels?: string;
    originFiles?: string;
    originDumpMethod?: string;
    originOwnership?: string;
    game?: string;
    system?: string;
    genre?: string;
    finalBuildDate?: string;
    releaseDate?: unknown;
    newsPage?: string;
  };
  const d = (data ?? {}) as Partial<PrototypeData>;

  // releaseDate is a json-typed attr, which the core passes through
  // unvalidated. Coerce both fields to strings so an object value cannot throw
  // "Objects are not valid as a React child" and 500 the article.
  const releaseDates = (Array.isArray(a.releaseDate) ? a.releaseDate : [])
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
    .map((r) => ({ region: text(r.region), date: text(r.date) }))
    .filter((r) => r.region !== "" || r.date !== "");
  const origin = [
    ["Type", "originType", a.originType],
    ["Lot", "originLot", a.originLot],
    ["EPROMs", "originEproms", a.originEproms],
    ["Board", "originBoard", a.originBoard],
    ["Disc type", "originDiscType", a.originDiscType],
    ["Dev kit", "originDevKit", a.originDevKit],
    ["Labels", "originLabels", a.originLabels],
    ["Files", "originFiles", a.originFiles],
    ["Dump method", "originDumpMethod", a.originDumpMethod],
    ["Ownership", "originOwnership", a.originOwnership],
  ] as const;

  return (
    <Infobox title={a.buildName ?? a.game ?? "Prototype"}>
      {d.titleScreenUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={d.titleScreenUrl} alt={a.game ?? "Title screen"} className="w-full" />
      ) : null}
      <Row label="Build date" value={a.buildDate} />
      <Row label="Status" value={a.status} />
      <Row label="DAT status" value={a.datStatus} />
      <Row label="Dumped by" value={a.dumpedBy?.join(", ")} />
      <Row label="Released by" value={a.releasedBy?.join(", ")} />
      <Row label="File dump date" value={a.fileDumpDate} />
      <Row label="File release date" value={a.fileReleaseDate} />
      {origin.some(([, , v]) => v) ? <SectionHead>Origin</SectionHead> : null}
      {origin.map(([label, key, value]) => (
        <Row key={label} label={label} value={rich(d.rich, key, value)} />
      ))}
      <Row label="Game" value={a.game} />
      <Row label="System" value={a.system} />
      <Row label="Genre" value={a.genre} />
      <Row label="Final build" value={a.finalBuildDate} />
      <Row
        label="Release date"
        value={
          releaseDates.length > 0 ? (
            <ul>
              {releaseDates.map((r, i) => (
                <li key={i}>
                  <small className="text-neutral-500">{r.region}</small> {r.date}
                </li>
              ))}
            </ul>
          ) : undefined
        }
      />
    </Infobox>
  );
}

/* ---- Board ---------------------------------------------------------------- */

type BoardData = {
  photoUrl: string | null;
  usedIn: PageLink[];
  rich: Record<string, RichSeg[]>;
};

function BoardView({ attrs, data }: ComponentViewProps) {
  const a = attrs as {
    hardwareId?: string;
    hardwareType?: string;
    hardwareDate?: string;
    chips?: string[];
    text?: string;
    system?: string;
    game?: string;
  };
  const d = (data ?? {}) as Partial<BoardData>;
  const usedIn = d.usedIn ?? [];

  return (
    <>
      <Infobox title={a.hardwareId ?? "Board"}>
        {d.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={d.photoUrl} alt={a.hardwareId ?? "Board photo"} className="w-full" />
        ) : null}
        <Row label="Type" value={a.hardwareType} />
        <Row label="Date" value={a.hardwareDate} />
        <Row label="Chips" value={a.chips?.join(", ")} />
        <Row label="Text" value={rich(d.rich, "text", a.text)} />
        <Row label="System" value={a.system} />
        <Row label="Game" value={a.game} />
      </Infobox>
      {usedIn.length > 0 ? (
        <section className="my-4">
          <h2 className="mb-2 text-lg font-semibold">Used in</h2>
          <LinkList links={usedIn} />
        </section>
      ) : null}
    </>
  );
}

/* ---- Video ---------------------------------------------------------------- */

function VideoView({ attrs }: ComponentViewProps) {
  const a = attrs as {
    videoDate?: string;
    videoStatus?: string;
    videoMedia?: string;
    transferredBy?: string[];
    game?: string[];
    system?: string;
    genre?: string;
  };
  return (
    <Infobox title={a.game?.join(", ") || "Video"}>
      <Row label="Date" value={a.videoDate} />
      <Row label="Status" value={a.videoStatus} />
      <Row label="Media" value={a.videoMedia} />
      <Row label="Transferred by" value={a.transferredBy?.join(", ")} />
      <Row label="Game" value={a.game?.join(", ")} />
      <Row label="System" value={a.system} />
      <Row label="Genre" value={a.genre} />
    </Infobox>
  );
}

/* ---- Lot ------------------------------------------------------------------ */

function LotView({ attrs }: ComponentViewProps) {
  const a = attrs as { name?: string; acquiredDate?: string; description?: string };
  return (
    <div className="my-4 rounded border border-neutral-300 bg-neutral-50 px-4 py-3 dark:border-neutral-700 dark:bg-neutral-900">
      <div className="text-lg font-bold">{a.name}</div>
      {a.acquiredDate ? (
        <div className="text-sm text-neutral-500">Acquired {a.acquiredDate}</div>
      ) : null}
      {a.description ? <p className="mt-1 text-sm">{a.description}</p> : null}
    </div>
  );
}

/* ---- Download --------------------------------------------------------------- */

type DownloadData = {
  url: string | null;
  exists: boolean;
  infoHref: string | null;
};

function DownloadView({ attrs, data }: ComponentViewProps) {
  const a = attrs as { file?: string; external?: unknown; raw?: string; title?: string };
  const d = (data ?? {}) as Partial<DownloadData>;
  const label = a.title ?? a.file ?? "file";
  // Only http(s) mirror URLs: `external` is a page-authored json attribute, so
  // an unfiltered href here would allow javascript:/data: XSS in an <a>.
  const external = (Array.isArray(a.external) ? a.external : []).filter(
    (u): u is string => typeof u === "string" && /^https?:\/\//i.test(u),
  );

  return (
    <div className="my-4 rounded border border-neutral-300 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-900">
      {d.url ? (
        <div>
          <a href={d.url} className="text-lg font-semibold hover:underline">
            Download {label}
          </a>
          {d.infoHref ? (
            <a href={d.infoHref} className="ml-2 text-sm text-neutral-500 hover:underline">
              (info)
            </a>
          ) : null}
        </div>
      ) : (
        <div className="font-semibold text-red-600 dark:text-red-400">
          Missing file{a.file ? `: ${a.file}` : ""}
        </div>
      )}
      {external.length > 0 ? (
        <ul className="mt-2 text-sm">
          {external.map((u, i) => (
            <li key={i}>
              <a href={u} rel="nofollow noopener" className="text-neutral-500 hover:underline">
                {u}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ---- FileList / FileEntry ---------------------------------------------------- */

function FileListView({ children }: ComponentViewProps) {
  return (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
            <th className="px-2 py-1">File</th>
            <th className="px-2 py-1 text-right">Size</th>
            <th className="px-2 py-1">Date</th>
            <th className="px-2 py-1">Comment</th>
            <th className="px-2 py-1">SHA-1</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function FileEntryView({ attrs }: ComponentViewProps) {
  const a = attrs as {
    filename?: string;
    date?: string;
    size?: number;
    comment?: string;
    crc32?: string;
    md5?: string;
    sha1?: string;
    indent?: number;
  };
  const hashTitle = [a.crc32 ? `CRC32 ${a.crc32}` : null, a.md5 ? `MD5 ${a.md5}` : null]
    .filter(Boolean)
    .join(", ");
  return (
    <tr className="border-b border-neutral-200 dark:border-neutral-800">
      <td
        className="px-2 py-1 font-mono"
        style={a.indent ? { paddingLeft: `${a.indent * 1.25 + 0.5}rem` } : undefined}
      >
        {a.filename}
      </td>
      <td className="whitespace-nowrap px-2 py-1 text-right">{humanSize(a.size)}</td>
      <td className="whitespace-nowrap px-2 py-1">{a.date}</td>
      <td className="px-2 py-1">{a.comment}</td>
      <td className="px-2 py-1">
        {a.sha1 ? (
          <small className="font-mono text-neutral-500" title={hashTitle || undefined}>
            {a.sha1}
          </small>
        ) : null}
      </td>
    </tr>
  );
}

/* ---- HexDump ---------------------------------------------------------------- */

type HexDumpLine = {
  offset: string;
  bytes: string;
  ascii?: string;
};

type HexDumpAnnotation = {
  line: number;
  start: number;
  length: number;
  field: string;
  value: string;
};

// childrenJson is page-authored and only checked for JSON validity by the
// core validator (children: "json" carries no shape), so every field is
// coerced here. Without this a page saying {"lines":[{}]} throws inside a
// server component and 500s the whole article.

function coerceHexDump(
  payload: unknown,
): { lines: HexDumpLine[]; annotations: HexDumpAnnotation[] } | null {
  if (!payload || typeof payload !== "object") return null;
  const d = payload as { lines?: unknown; annotations?: unknown };
  if (!Array.isArray(d.lines) || d.lines.length === 0) return null;
  const lines = d.lines.map((l) => {
    const row = (l && typeof l === "object" ? l : {}) as Record<string, unknown>;
    return {
      offset: text(row.offset),
      bytes: text(row.bytes),
      ...(row.ascii === undefined ? {} : { ascii: text(row.ascii) }),
    };
  });
  const annotations = (Array.isArray(d.annotations) ? d.annotations : [])
    .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
    .map((a) => ({
      line: int(a.line),
      start: int(a.start),
      length: int(a.length),
      field: text(a.field),
      value: text(a.value),
    }));
  return { lines, annotations };
}

function HexDumpRow({
  line,
  annotations,
  index,
}: {
  line: HexDumpLine;
  annotations: HexDumpAnnotation[];
  index: number;
}) {
  const bytes = line.bytes.split(" ");
  const anns = annotations
    .filter((a) => a.line === index)
    .sort((a, b) => a.start - b.start);

  const cells: ReactNode[] = [];
  const addCell = (node: ReactNode) => {
    if (cells.length > 0) cells.push(" ");
    cells.push(node);
  };
  let pos = 0;
  for (const a of anns) {
    const start = Math.max(a.start, pos);
    const end = Math.min(a.start + a.length, bytes.length);
    if (end <= start) continue;
    if (start > pos) addCell(bytes.slice(pos, start).join(" "));
    addCell(
      <span
        key={start}
        title={`${a.field}: ${a.value}`}
        className="cursor-help underline decoration-neutral-400 decoration-dotted underline-offset-2"
      >
        {bytes.slice(start, end).join(" ")}
      </span>,
    );
    pos = end;
  }
  if (pos < bytes.length) addCell(bytes.slice(pos).join(" "));

  return (
    <div className="whitespace-pre">
      <span className="text-neutral-400 dark:text-neutral-500">{line.offset}</span>
      {"  "}
      {cells}
      {line.ascii !== undefined ? (
        <>
          {"  "}
          <span className="text-neutral-500">{line.ascii}</span>
        </>
      ) : null}
    </div>
  );
}

function HexDumpView({ children, childrenJson }: ComponentViewProps) {
  const dump = coerceHexDump(childrenJson);

  if (!dump) {
    // Malformed or missing payload: fall back to whatever the core rendered.
    return (
      <div className="my-4 max-h-96 overflow-auto rounded border border-neutral-300 bg-neutral-50 text-xs dark:border-neutral-700 dark:bg-neutral-900">
        {children}
      </div>
    );
  }
  const { lines, annotations } = dump;

  return (
    <details className="my-4 rounded border border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900">
      <summary className="cursor-pointer px-3 py-1.5 text-sm font-semibold">
        Raw header data ({lines.length} {lines.length === 1 ? "line" : "lines"})
      </summary>
      <div className="max-h-96 overflow-x-auto px-3 pb-3 font-mono text-xs leading-5">
        {lines.map((line, i) => (
          <HexDumpRow key={i} line={line} annotations={annotations} index={i} />
        ))}
      </div>
    </details>
  );
}

/* ---- GameNav ------------------------------------------------------------------ */

type GameNavData = {
  prototypes: PageLink[];
  videos: PageLink[];
};

function GameNavView({ attrs, data }: ComponentViewProps) {
  const a = attrs as { game?: string };
  const d = (data ?? {}) as Partial<GameNavData>;
  const groups = [
    { heading: `Prototypes of ${a.game ?? ""}`, links: d.prototypes ?? [] },
    { heading: `Videos of ${a.game ?? ""}`, links: d.videos ?? [] },
  ].filter((g) => g.links.length > 0);
  if (groups.length === 0) return null;

  return (
    <nav className="my-4 rounded border border-neutral-300 bg-neutral-50 p-3 text-sm dark:border-neutral-700 dark:bg-neutral-900">
      {groups.map((g) => (
        <div key={g.heading} className="mt-2 first:mt-0">
          <div className="font-semibold">{g.heading}</div>
          <LinkList links={g.links} />
        </div>
      ))}
    </nav>
  );
}

/* ---- HardwareSystem ----------------------------------------------------------- */

type BoardTile = {
  href: string;
  title: string;
  photoUrl: string | null;
};

function HardwareSystemView({ data }: ComponentViewProps) {
  const d = (data ?? {}) as { boards?: BoardTile[] };
  const boards = d.boards ?? [];
  if (boards.length === 0) return null;

  return (
    <div className="my-4 flex flex-wrap gap-3">
      {boards.map((b) => (
        <figure
          key={b.href}
          className="w-40 rounded border border-neutral-300 bg-neutral-50 p-2 text-center text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          {b.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={b.photoUrl} alt={b.title} className="mx-auto max-h-32 w-auto" />
          ) : (
            <div className="grid h-32 place-items-center text-neutral-400">no photo</div>
          )}
          <figcaption className="mt-1">
            <a href={b.href} className="hover:underline">
              {b.title}
            </a>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/* ---- inline components ---------------------------------------------------------- */

function RegionDateView({ attrs }: ComponentViewProps) {
  const a = attrs as { region?: string; date?: string };
  return (
    <span>
      <small className="text-neutral-500">{a.region}</small> {a.date}
    </span>
  );
}


/* ---- bindings --------------------------------------------------------------------- */

export const hpBindings: Record<string, ComponentBinding> = {
  Prototype: {
    async loader(attrs, ctx): Promise<PrototypeData> {
      const [titleScreenUrl, rich] = await Promise.all([
        resolveMediaUrl(ctx, attrs.titleScreen),
        richAttrs(ctx, attrs, PROTOTYPE_RICH),
      ]);
      return { titleScreenUrl, rich };
    },
    View: PrototypeView,
  },

  Board: {
    async loader(attrs, ctx): Promise<BoardData> {
      const hardwareId = str(attrs.hardwareId);
      const [photoUrl, rich] = await Promise.all([
        resolveMediaUrl(ctx, attrs.photo),
        richAttrs(ctx, attrs, ["text"]),
      ]);
      const runQuery = ctx.runQuery;
      if (!runQuery || !hardwareId) return { photoUrl, usedIn: [], rich };
      const res = await runQuery({
        from: "Prototype",
        where: { origin_board: hardwareId },
        select: [],
        limit: 175,
      });
      const usedIn = res.kind === "rows" ? res.rows.map((r) => toLink(ctx, r)) : [];
      return { photoUrl, usedIn, rich };
    },
    View: BoardView,
  },

  Video: { View: VideoView },

  Lot: { View: LotView },

  Download: {
    async loader(attrs, ctx): Promise<DownloadData> {
      const file = str(attrs.file);
      const url = await resolveMediaUrl(ctx, file);
      return {
        url,
        exists: url !== null,
        infoHref: file ? ctx.pageHref({ ns: "file", slug: file }) : null,
      };
    },
    View: DownloadView,
  },

  FileList: { View: FileListView },

  FileEntry: { View: FileEntryView },

  HexDump: { View: HexDumpView },

  GameNav: {
    async loader(attrs, ctx): Promise<GameNavData> {
      const game = str(attrs.game);
      const runQuery = ctx.runQuery;
      if (!runQuery || !game) return { prototypes: [], videos: [] };
      const run = async (from: string, sort: { field: string }[]) => {
        const res = await runQuery({ from, where: { game }, sort, limit: 175 });
        return res.kind === "rows" ? res.rows.map((r) => toLink(ctx, r)) : [];
      };
      // sort_date is derive-only (not a registry field), so built_after, whose
      // fallback chain subsumes it, is the final Prototype sort key here.
      const [prototypes, videos] = await Promise.all([
        run("Prototype", [{ field: "sort_number" }, { field: "built_after" }]),
        run("Video", [{ field: "video_date" }]),
      ]);
      return { prototypes, videos };
    },
    View: GameNavView,
  },

  HardwareSystem: {
    async loader(attrs, ctx): Promise<{ boards: BoardTile[] }> {
      const system = str(attrs.system);
      const runQuery = ctx.runQuery;
      if (!runQuery || !system) return { boards: [] };
      const res = await runQuery({ from: ["Board"], where: { system }, limit: 500 });
      if (res.kind !== "rows") return { boards: [] };
      const names = [
        ...new Set(res.rows.map((r) => str(r.data.photo)).filter((n): n is string => n !== undefined)),
      ];
      const media =
        ctx.resolveMedia && names.length > 0
          ? await ctx.resolveMedia(names)
          : new Map<string, string | null>();
      const boards = res.rows.map((r) => {
        const photo = str(r.data.photo);
        return {
          href: ctx.pageHref(r.page),
          title: r.page.displayTitle ?? r.page.title,
          photoUrl: photo ? (media.get(photo) ?? null) : null,
        };
      });
      return { boards };
    },
    View: HardwareSystemView,
  },

  RegionDate: { View: RegionDateView },
};
