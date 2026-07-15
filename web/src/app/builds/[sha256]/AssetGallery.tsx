"use client";

// Grouped preview of a build's viewable assets: image thumbnails, audio embeds
// with waveforms, small video players, text excerpt cards. The server page
// passes an already-capped subset plus the full per-kind totals; when a kind is
// truncated, a "view all" affordance links to /builds/<sha256>/assets.
// Images and text open the same AssetViewer lightbox the file tree uses.

import { useMemo, useState } from "react";
import Link from "next/link";
import AssetViewer, { assetUrl, humanSize, type ViewableAsset } from "./AssetViewer";
import AudioEmbed from "./AudioEmbed";
import SourceCode from "./SourceCode";

const SECTIONS: { kind: string; title: string }[] = [
  { kind: "image", title: "Images" },
  { kind: "audio", title: "Audio" },
  { kind: "video", title: "Video" },
  { kind: "source", title: "Source code" },
  { kind: "text", title: "Text" },
];

function baseName(path: string): string {
  return path.split("/").pop() || path;
}

export default function AssetGallery({
  sha256,
  assets,
  totals,
  excerpts,
}: {
  sha256: string;
  /** Assets to display, grouped in kind order (capped per kind by the server page). */
  assets: ViewableAsset[];
  /** Full per-kind counts, so truncation is visible. */
  totals: Record<string, number>;
  /** Text asset path → excerpt of its leading bytes. */
  excerpts: Record<string, string>;
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  const indexByPath = useMemo(() => new Map(assets.map((a, i) => [a.path, i] as const)), [assets]);
  const open = (a: ViewableAsset) => setViewing(indexByPath.get(a.path) ?? null);
  const allHref = `/builds/${sha256}/assets`;

  return (
    <>
      {SECTIONS.map(({ kind, title }) => {
        const group = assets.filter((a) => a.kind === kind);
        if (group.length === 0) return null;
        const total = totals[kind] ?? group.length;
        const more = total - group.length;
        return (
          <div key={kind} className="mt-5 first:mt-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              {title} <span className="font-normal">({total})</span>
            </h3>

            {kind === "image" && (
              <div className="mt-2 flex flex-wrap gap-2">
                {group.map((a) => (
                  <button
                    key={a.path}
                    onClick={() => open(a)}
                    title={a.path}
                    className="h-24 w-24 overflow-hidden rounded border border-neutral-200 bg-neutral-50 hover:border-sky-400 dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-sky-600"
                  >
                    {/* Not next/image: blobs are local, immutable, hard-cached (see AssetViewer). */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={assetUrl(a)} alt={a.path} loading="lazy" className="h-full w-full object-contain" />
                  </button>
                ))}
                {more > 0 && (
                  <Link
                    href={allHref}
                    className="flex h-24 w-24 items-center justify-center rounded border border-dashed border-neutral-300 text-center text-xs text-neutral-500 hover:border-sky-400 hover:text-sky-700 dark:border-neutral-700 dark:hover:border-sky-600 dark:hover:text-sky-400"
                  >
                    view more…
                    <br />+{more}
                  </Link>
                )}
              </div>
            )}

            {kind === "audio" && (
              <div className="mt-2 grid gap-1.5 md:grid-cols-2 xl:grid-cols-3">
                {group.map((a) => (
                  <AudioEmbed key={a.path} asset={a} />
                ))}
              </div>
            )}

            {kind === "video" && (
              <div className="mt-2 flex flex-wrap gap-2">
                {group.map((a) => (
                  <video
                    key={a.path}
                    controls
                    preload="none"
                    src={assetUrl(a)}
                    title={a.path}
                    className="h-36 rounded border border-neutral-200 dark:border-neutral-800"
                  />
                ))}
              </div>
            )}

            {(kind === "source" || kind === "text") && (
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {group.map((a) => (
                  <button
                    key={a.path}
                    onClick={() => open(a)}
                    title={a.path}
                    className="rounded border border-neutral-200 p-3 text-left hover:border-sky-400 dark:border-neutral-800 dark:hover:border-sky-600"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-mono text-xs text-sky-700 dark:text-sky-400">
                        {baseName(a.path)}
                      </span>
                      <span className="shrink-0 text-[10px] text-neutral-400">{humanSize(a.size)}</span>
                    </div>
                    <pre className="mt-1.5 line-clamp-4 whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-neutral-500">
                      {kind === "source" ? (
                        <SourceCode path={a.path} text={excerpts[a.path] ?? ""} />
                      ) : (
                        excerpts[a.path] ?? ""
                      )}
                    </pre>
                  </button>
                ))}
              </div>
            )}

            {kind !== "image" && more > 0 && (
              <Link
                href={allHref}
                className="mt-2 inline-block text-xs text-sky-700 hover:underline dark:text-sky-400"
              >
                view more… (all {total})
              </Link>
            )}
          </div>
        );
      })}

      {viewing !== null && assets[viewing] && (
        <AssetViewer
          assets={assets}
          index={viewing}
          onClose={() => setViewing(null)}
          onNavigate={setViewing}
        />
      )}
    </>
  );
}
