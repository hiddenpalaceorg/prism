/**
 * Hidden Palace server bindings for the cube components in schemas.ts.
 * Loaders do all data fetching (media resolution, object queries, hrefs) and
 * return plain JSON; Views are client-safe presentational functions.
 */

import type { ReactNode } from "react";
import type { QueryRow } from "cube";
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

/* ---- Prototype ----------------------------------------------------------- */

type PrototypeData = {
  titleScreenUrl: string | null;
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

  const releaseDates = (Array.isArray(a.releaseDate) ? a.releaseDate : []).filter(
    (r): r is { region?: string; date?: string } => typeof r === "object" && r !== null,
  );
  const origin = [
    ["Type", a.originType],
    ["Lot", a.originLot],
    ["EPROMs", a.originEproms],
    ["Board", a.originBoard],
    ["Disc type", a.originDiscType],
    ["Dev kit", a.originDevKit],
    ["Labels", a.originLabels],
    ["Files", a.originFiles],
    ["Dump method", a.originDumpMethod],
    ["Ownership", a.originOwnership],
  ] as const;

  return (
    <Infobox title={a.buildName ?? a.game ?? "Prototype"}>
      {d.titleScreenUrl ? (
        <img src={d.titleScreenUrl} alt={a.game ?? "Title screen"} className="w-full" />
      ) : null}
      <Row label="Build date" value={a.buildDate} />
      <Row label="Status" value={a.status} />
      <Row label="DAT status" value={a.datStatus} />
      <Row label="Dumped by" value={a.dumpedBy?.join(", ")} />
      <Row label="Released by" value={a.releasedBy?.join(", ")} />
      <Row label="File dump date" value={a.fileDumpDate} />
      <Row label="File release date" value={a.fileReleaseDate} />
      {origin.some(([, v]) => v) ? <SectionHead>Origin</SectionHead> : null}
      {origin.map(([label, value]) => (
        <Row key={label} label={label} value={value} />
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
          <img src={d.photoUrl} alt={a.hardwareId ?? "Board photo"} className="w-full" />
        ) : null}
        <Row label="Type" value={a.hardwareType} />
        <Row label="Date" value={a.hardwareDate} />
        <Row label="Chips" value={a.chips?.join(", ")} />
        <Row label="Text" value={a.text} />
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
  const external = (Array.isArray(a.external) ? a.external : []).filter(
    (u): u is string => typeof u === "string" && u !== "",
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
  const d =
    childrenJson && typeof childrenJson === "object"
      ? (childrenJson as { lines?: unknown; annotations?: unknown })
      : null;
  const lines = d && Array.isArray(d.lines) ? (d.lines as HexDumpLine[]) : null;

  if (!lines || lines.length === 0) {
    // Malformed or missing payload: fall back to whatever the core rendered.
    return (
      <div className="my-4 max-h-96 overflow-auto rounded border border-neutral-300 bg-neutral-50 text-xs dark:border-neutral-700 dark:bg-neutral-900">
        {children}
      </div>
    );
  }
  const annotations =
    d && Array.isArray(d.annotations) ? (d.annotations as HexDumpAnnotation[]) : [];

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

function TcrfLinkView({ attrs }: ComponentViewProps) {
  const a = attrs as { page?: string };
  const page = a.page ?? "";
  return (
    <a
      href={`https://tcrf.net/${encodeURI(page.replace(/ /g, "_"))}`}
      rel="nofollow noopener"
      className="inline-block rounded border border-neutral-300 px-1.5 py-0.5 text-xs dark:border-neutral-700"
    >
      TCRF: {page}
    </a>
  );
}

/* ---- bindings --------------------------------------------------------------------- */

export const hpBindings: Record<string, ComponentBinding> = {
  Prototype: {
    async loader(attrs, ctx): Promise<PrototypeData> {
      return { titleScreenUrl: await resolveMediaUrl(ctx, attrs.titleScreen) };
    },
    View: PrototypeView,
  },

  Board: {
    async loader(attrs, ctx): Promise<BoardData> {
      const hardwareId = str(attrs.hardwareId);
      const photoUrl = await resolveMediaUrl(ctx, attrs.photo);
      const runQuery = ctx.runQuery;
      if (!runQuery || !hardwareId) return { photoUrl, usedIn: [] };
      const res = await runQuery({
        from: "Prototype",
        where: { origin_board: hardwareId },
        select: [],
        limit: 175,
      });
      const usedIn = res.kind === "rows" ? res.rows.map((r) => toLink(ctx, r)) : [];
      return { photoUrl, usedIn };
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

  TcrfLink: { View: TcrfLinkView },
};
