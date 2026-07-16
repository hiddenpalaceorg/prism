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
  kind: string; // image | audio | video | document | source | text | binary
}

export function assetUrl(a: ViewableAsset): string {
  return `/api/asset/${a.sha256}`;
}

/** Where <img> should point: browsers render every image mime we extract
 *  except TGA and TIFF, which go through the server's PNG conversion. Kept in
 *  sync with pngConvertible (imgpng.ts) — not imported: that module pulls the
 *  decoders into the client bundle. */
export function imageSrc(a: ViewableAsset): string {
  return a.mime === "image/x-tga" || a.mime === "image/tiff" ? `${assetUrl(a)}/png` : assetUrl(a);
}

/** Where <video> should point: MP4/WebM play natively, while MPEG-1/2 program
 *  streams (.mpg, DVD .vob) go through the server's transcode. */
export function videoSrc(a: ViewableAsset): string {
  return a.mime === "video/mpeg" ? `${assetUrl(a)}/video` : assetUrl(a);
}

/** Poster still for a video asset (server-side ffmpeg frame grab). */
export function videoThumbSrc(a: ViewableAsset): string {
  return `${assetUrl(a)}/thumb`;
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

// The "can't show this inline" downgrade shared by the bodies whose rendering
// depends on an optional server-side converter.
function DownloadCard({ asset }: { asset: ViewableAsset }) {
  const name = asset.path.split("/").pop() || asset.path;
  return (
    <div className="flex flex-col items-center gap-3 rounded bg-neutral-900 p-10 text-sm text-neutral-300">
      <p>No inline preview for this file.</p>
      <a
        href={assetUrl(asset)}
        download={name}
        className="rounded bg-neutral-700 px-3 py-1.5 text-neutral-100 hover:bg-neutral-600"
      >
        Download {name}
      </a>
    </div>
  );
}

// How often the player re-asks the server about an in-flight transcode.
const TRANSCODE_POLL_MS = 4_000;

/**
 * Video player over an extracted asset, shared by the viewer body and the
 * gallery cards. MP4/WebM play natively; MPEG program streams (.mpg, DVD
 * .vob) go through the server's ffmpeg transcode, which for DVD-sized inputs
 * may still be running when playback is first attempted — the player then
 * polls ./video/status, showing progress over the poster still, and starts
 * playback when the stream is ready. A transcode that is unavailable (no
 * ffmpeg on the server) or fails renders `fallback` (a download affordance).
 */
export function VideoPlayer({
  asset,
  className,
  fallback,
}: {
  asset: ViewableAsset;
  className?: string;
  fallback?: React.ReactNode;
}) {
  const [phase, setPhase] = useState<"player" | "preparing" | "failed">("player");
  // Bumped when a finished transcode re-mounts the <video>, so play resumes
  // by itself (the user already hit play once). Also the retry limiter: a
  // second error after a "ready" means the stream really doesn't play here.
  const [readyAt, setReadyAt] = useState(0);
  const [percent, setPercent] = useState<number | null>(null);

  useEffect(() => {
    if (phase !== "preparing") return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      let state = "failed";
      let pct: number | null = null;
      try {
        const res = await fetch(`${assetUrl(asset)}/video/status`, { cache: "no-store" });
        if (res.ok) {
          const s = (await res.json()) as { state: string; percent?: number | null };
          state = s.state;
          pct = typeof s.percent === "number" ? s.percent : null;
        }
      } catch {
        // Network blip — poll again rather than giving up on a live transcode.
        state = "transcoding";
      }
      if (cancelled) return;
      if (state === "ready") {
        setPhase("player");
        setReadyAt((n) => n + 1);
      } else if (state === "transcoding") {
        setPercent(pct);
        timer = window.setTimeout(poll, TRANSCODE_POLL_MS);
      } else {
        setPhase("failed");
      }
    };
    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phase, asset]);

  if (phase === "failed") {
    const name = asset.path.split("/").pop() || asset.path;
    return (
      fallback ?? (
        <a
          href={assetUrl(asset)}
          download={name}
          className={`flex min-w-[12rem] items-center justify-center bg-neutral-950 px-6 text-xs text-neutral-300 hover:text-white hover:underline ${className ?? ""}`}
        >
          No preview — download {name}
        </a>
      )
    );
  }
  if (phase === "preparing") {
    return (
      <div className={`relative min-w-[16rem] overflow-hidden bg-neutral-950 ${className ?? ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={videoThumbSrc(asset)}
          alt=""
          className="h-full w-full object-contain opacity-40"
          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
        />
        <span className="absolute inset-0 flex animate-pulse items-center justify-center px-4 text-center text-xs text-neutral-200">
          Preparing video…{percent != null ? ` ${percent}%` : ""}
        </span>
      </div>
    );
  }
  return (
    <video
      key={readyAt}
      controls
      preload="none"
      autoPlay={readyAt > 0}
      poster={videoThumbSrc(asset)}
      src={videoSrc(asset)}
      title={asset.path}
      className={className}
      onError={() => {
        if (asset.mime === "video/mpeg" && readyAt === 0) setPhase("preparing");
        else setPhase("failed");
      }}
    />
  );
}

// The lightbox body wrapping the shared player: failures fall back to a
// download card rather than an error.
function VideoBody({ asset }: { asset: ViewableAsset }) {
  return (
    <VideoPlayer
      asset={asset}
      className="max-h-[75vh] max-w-[90vw] rounded"
      fallback={<DownloadCard asset={asset} />}
    />
  );
}

// PDFs embed the browser's own viewer; PostScript/EPS goes through the
// server's Ghostscript rasterization. Either can be unavailable (mobile
// browsers won't embed PDFs; the server may lack Ghostscript), so both
// fall back to a download card rather than an error.
function DocumentBody({ asset }: { asset: ViewableAsset }) {
  const [failed, setFailed] = useState(false);
  const url = assetUrl(asset);
  const fallback = <DownloadCard asset={asset} />;
  if (asset.mime === "application/pdf") {
    return (
      <object data={url} type="application/pdf" className="h-[75vh] w-[min(70rem,90vw)] rounded" aria-label={asset.path}>
        {fallback}
      </object>
    );
  }
  if (failed) return fallback;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${url}/png`}
      alt={asset.path}
      className="max-h-[75vh] max-w-[90vw] rounded object-contain"
      onError={() => setFailed(true)}
    />
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
      return <VideoBody asset={asset} />;
    case "document":
      return <DocumentBody asset={asset} />;
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
