"use client";

// Lightbox over the build's viewable assets. Media loads only when an asset is
// opened (and the blob URLs are content-addressed + immutable, so anything
// once seen comes back from browser cache). ← → step through the list, Esc closes.

import { useEffect, useState } from "react";
import { hexDump } from "@/lib/hexdump";
import SourceCode from "./SourceCode";

/** Mirrors queries.ts BuildAsset — redeclared here so client components don't
 *  import the server-only queries module (it pulls in pg). */
export interface ViewableAsset {
  path: string;
  sha256: string;
  size: number;
  mime: string;
  kind: string; // image | audio | video | source | text | binary
}

export function assetUrl(a: ViewableAsset): string {
  return `/api/asset/${a.sha256}`;
}

/** Where <img> should point: browsers render every image mime we extract
 *  except TGA, which goes through the server's PNG conversion. Kept in sync
 *  with pngConvertible (imgpng.ts) — not imported: that module pulls the
 *  decoders into the client bundle. */
export function imageSrc(a: ViewableAsset): string {
  return a.mime === "image/x-tga" ? `${assetUrl(a)}/png` : assetUrl(a);
}

export function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${bytes} B` : `${v.toFixed(1)} ${units[i]}`;
}

// Show at most this much decoded text — a 20MB DOM node makes the tab crawl.
const TEXT_DISPLAY_CAP = 1_000_000;

function TextBody({ asset }: { asset: ViewableAsset }) {
  const url = assetUrl(asset);
  // No reset-on-url-change needed: the viewer remounts this per asset (see the
  // key on <Body/>), so "loading" as initial state always holds.
  const [state, setState] = useState<{ text: string; truncated: boolean } | "loading" | "error">(
    "loading"
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const text = new TextDecoder().decode(buf.slice(0, TEXT_DISPLAY_CAP));
        if (!cancelled) setState({ text, truncated: buf.byteLength > TEXT_DISPLAY_CAP });
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (state === "loading") return <p className="p-6 text-sm text-neutral-400">Loading…</p>;
  if (state === "error") return <p className="p-6 text-sm text-red-500">Failed to load file.</p>;
  return (
    <div className="max-h-[70vh] w-[min(80rem,90vw)] overflow-auto rounded bg-white p-4 dark:bg-neutral-900">
      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-neutral-800 dark:text-neutral-200">
        {asset.kind === "source" ? <SourceCode path={asset.path} text={state.text} /> : state.text}
      </pre>
      {state.truncated && (
        <p className="mt-3 text-xs text-neutral-400">Preview truncated — download for the full file.</p>
      )}
    </div>
  );
}

// The analyzer stores only this much of an unidentified file (viewable.py
// SNIPPET_BYTES) — a blob exactly this long is (almost surely) a truncated head.
const SNIPPET_BYTES = 2048;

// Unidentified files: xxd-style hex view over the stored head snippet. The
// blob is raw bytes, so this rendering can evolve without re-analysis.
function HexBody({ asset }: { asset: ViewableAsset }) {
  const url = assetUrl(asset);
  const [state, setState] = useState<Uint8Array | "loading" | "error">("loading");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (!cancelled) setState(new Uint8Array(buf));
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (state === "loading") return <p className="p-6 text-sm text-neutral-400">Loading…</p>;
  if (state === "error") return <p className="p-6 text-sm text-red-500">Failed to load file.</p>;
  return (
    <div className="max-h-[70vh] overflow-auto rounded bg-white p-4 dark:bg-neutral-900">
      <pre className="whitespace-pre font-mono text-xs leading-5 text-neutral-800 dark:text-neutral-200">
        {hexDump(state)}
      </pre>
      {asset.size >= SNIPPET_BYTES && (
        <p className="mt-3 text-xs text-neutral-400">
          Unidentified file — only its first 2 KB is stored.
        </p>
      )}
    </div>
  );
}

function Body({ asset }: { asset: ViewableAsset }) {
  const [failed, setFailed] = useState(false);
  const url = assetUrl(asset);
  if (failed) {
    return <p className="p-6 text-sm text-red-500">Failed to load media.</p>;
  }
  switch (asset.kind) {
    case "image":
      return (
        // Not next/image: blobs are local, immutable, and served with hard
        // cache headers — optimization would only re-encode them.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageSrc(asset)}
          alt={asset.path}
          className="max-h-[75vh] max-w-[90vw] rounded object-contain"
          onError={() => setFailed(true)}
        />
      );
    case "audio":
      return <audio controls src={url} className="w-[min(40rem,85vw)]" onError={() => setFailed(true)} />;
    case "video":
      return (
        <video
          controls
          src={url}
          className="max-h-[75vh] max-w-[90vw] rounded"
          onError={() => setFailed(true)}
        />
      );
    case "binary":
      return <HexBody asset={asset} />;
    default:
      return <TextBody asset={asset} />;
  }
}

export default function AssetViewer({
  assets,
  index,
  onClose,
  onNavigate,
}: {
  assets: ViewableAsset[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const asset = assets[index];
  const prev = () => onNavigate((index - 1 + assets.length) % assets.length);
  const next = () => onNavigate((index + 1) % assets.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The overlay owns the viewport while open; keep the page from scrolling under it.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const name = asset.path.split("/").pop() || asset.path;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Asset viewer: ${name}`}
    >
      <div
        className="flex items-center gap-3 bg-neutral-950/80 px-4 py-2 text-sm text-neutral-200"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 flex-1 truncate font-mono" title={asset.path}>
          {asset.path}
        </span>
        <span className="shrink-0 text-xs text-neutral-400">
          {humanSize(asset.size)} · {asset.mime}
        </span>
        <a
          href={assetUrl(asset)}
          download={name}
          className="shrink-0 text-xs text-neutral-300 hover:text-white hover:underline"
        >
          Download
        </a>
        <button
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded px-2 py-0.5 text-neutral-300 hover:bg-neutral-800 hover:text-white"
        >
          &times;
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 p-4">
        {assets.length > 1 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            aria-label="Previous asset"
            className="shrink-0 rounded-full bg-neutral-900/70 px-3 py-2 text-lg text-neutral-300 hover:bg-neutral-800 hover:text-white"
          >
            ‹
          </button>
        )}
        {/* Remount per asset so per-file load state never bleeds across navigation. */}
        <div className="flex min-w-0 items-center justify-center" onClick={(e) => e.stopPropagation()}>
          <Body key={asset.sha256} asset={asset} />
        </div>
        {assets.length > 1 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            aria-label="Next asset"
            className="shrink-0 rounded-full bg-neutral-900/70 px-3 py-2 text-lg text-neutral-300 hover:bg-neutral-800 hover:text-white"
          >
            ›
          </button>
        )}
      </div>

      {assets.length > 1 && (
        <div className="pb-3 text-center text-xs text-neutral-400" onClick={(e) => e.stopPropagation()}>
          {index + 1} / {assets.length}
        </div>
      )}
    </div>
  );
}
