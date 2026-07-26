"use client";

// Lightbox over a build's community media — the media-side counterpart of
// AssetViewer. ← → step through the gallery, Esc closes. Photos get the same
// zoom/pan viewport as image assets (a disc scan is many times the size of its
// grid cell); video plays inline over its poster.

import { useEffect, useState } from "react";
import { humanSize } from "@/lib/format";
import type { BuildMediaView } from "@/lib/media";
import ZoomPan from "./ZoomPan";

/** Where the Download link points. Pages draw media from the public bucket
 *  gateway, which serves every blob under its hash with no extension; this
 *  route streams the same bytes under the name the file was uploaded as. */
function mediaDownloadUrl(item: BuildMediaView): string {
  return `/api/media/${item.sha256}`;
}

// The probe <img> measures the natural size ZoomPan needs for its fit scale;
// the blob is immutable and hard-cached, so the visible <img> re-uses the
// fetched bytes.
function ImageBody({ item }: { item: BuildMediaView }) {
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  if (failed) {
    return <p className="p-6 text-sm text-red-500">Failed to load media.</p>;
  }
  if (!size) {
    return (
      <>
        <p className="p-6 text-sm text-neutral-400">Loading…</p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.url}
          alt=""
          className="hidden"
          onLoad={(e) =>
            setSize({ width: e.currentTarget.naturalWidth || 1, height: e.currentTarget.naturalHeight || 1 })
          }
          onError={() => setFailed(true)}
        />
      </>
    );
  }
  return (
    <div className="relative h-[75vh] w-[min(85rem,92vw)]">
      <ZoomPan contentSize={size} className="h-full w-full rounded bg-neutral-900">
        {(scale) => (
          // Not next/image: blobs are content-addressed, immutable, and served
          // with hard cache headers, so optimization would only re-encode them.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.url}
            alt={item.filename}
            draggable={false}
            className="h-full w-full"
            // Screenshots read pixel-crisp when magnified past 1:1.
            style={{ imageRendering: scale > 1 ? "pixelated" : "auto" }}
          />
        )}
      </ZoomPan>
    </div>
  );
}

function Body({ item }: { item: BuildMediaView }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <p className="p-6 text-sm text-red-500">Failed to load media.</p>;
  }
  // Uploads are sniffed to MP4/WebM and PNG/JPEG/GIF/WebP (sniffMedia), so
  // there is nothing here the browser cannot play or draw itself.
  if (item.kind === "video") {
    return (
      <video
        controls
        preload="metadata"
        poster={item.posterUrl ?? undefined}
        src={item.url}
        title={item.filename}
        className="max-h-[75vh] max-w-[90vw] rounded bg-black"
        onError={() => setFailed(true)}
      />
    );
  }
  return <ImageBody item={item} />;
}

export default function MediaViewer({
  items,
  index,
  onClose,
  onNavigate,
}: {
  items: BuildMediaView[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const item = items[index];
  const prev = () => onNavigate((index - 1 + items.length) % items.length);
  const next = () => onNavigate((index + 1) % items.length);

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

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Media viewer: ${item.filename}`}
    >
      <div
        className="flex items-center gap-3 bg-neutral-950/80 px-4 py-2 text-sm text-neutral-200"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 flex-1 truncate font-mono" title={item.filename}>
          {item.filename}
        </span>
        <span className="hidden shrink-0 text-xs text-neutral-400 sm:inline">
          by {item.author} · {item.created_at.slice(0, 10)}
        </span>
        <span className="shrink-0 text-xs text-neutral-400">
          {humanSize(item.size)} · {item.content_type}
        </span>
        <a
          href={mediaDownloadUrl(item)}
          download={item.filename}
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
        {items.length > 1 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            aria-label="Previous item"
            className="shrink-0 rounded-full bg-neutral-900/70 px-3 py-2 text-lg text-neutral-300 hover:bg-neutral-800 hover:text-white"
          >
            &lsaquo;
          </button>
        )}
        {/* Remount per item so per-file load state never bleeds across navigation. */}
        <div className="flex min-w-0 items-center justify-center" onClick={(e) => e.stopPropagation()}>
          <Body key={item.id} item={item} />
        </div>
        {items.length > 1 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            aria-label="Next item"
            className="shrink-0 rounded-full bg-neutral-900/70 px-3 py-2 text-lg text-neutral-300 hover:bg-neutral-800 hover:text-white"
          >
            &rsaquo;
          </button>
        )}
      </div>

      {items.length > 1 && (
        <div className="pb-3 text-center text-xs text-neutral-400" onClick={(e) => e.stopPropagation()}>
          {index + 1} / {items.length}
        </div>
      )}
    </div>
  );
}
