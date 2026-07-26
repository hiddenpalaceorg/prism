"use client";

// Single per-page owner of the community-media lightbox, mirroring
// AssetViewerHost: anything that shows a media thumbnail (the header identity
// photo, the media grid) opens it through this context. The open item is
// reflected in the URL fragment (#media-<id>), so a photo is linkable and Back
// closes the viewer. pushState/replaceState are shallow, so opening one never
// refetches the page.
//
// The host also owns the item list. Uploads finish faster than the ISR-cached
// build page comes back with them, so a finished row is adopted here and shows
// in the grid (and in the viewer's sequence) until a refresh brings it around.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { BuildMediaView } from "@/lib/media";
import MediaViewer from "./MediaViewer";

// The order the gallery steps through, matching how MediaSection lays its
// sections out. Hardcoded rather than imported from lib/media, whose value
// exports drag node builtins into the client bundle.
const KIND_ORDER = ["screenshot", "video", "physical"];

const HASH_PREFIX = "#media-";

interface MediaContext {
  /** Every media item on the page, in gallery order. */
  items: BuildMediaView[];
  /** Open the lightbox on one item; an id that is no longer on the page shows
   *  nothing (a link to a since-deleted photo). */
  open: (id: number) => void;
  /** Adopt a row this page just uploaded. */
  add: (item: BuildMediaView) => void;
  /** Forget an adopted row (deleted before the refresh landed). */
  drop: (id: number) => void;
  /** Update an adopted row in place, e.g. its physical-photo label. */
  patch: (id: number, fields: Partial<BuildMediaView>) => void;
}

const Ctx = createContext<MediaContext | null>(null);

/** The page's media list and lightbox. Only valid under a MediaViewerHost. */
export function useMedia(): MediaContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMedia() outside a MediaViewerHost");
  return ctx;
}

/** Id in a URL fragment, or null when no item is deep-linked there. */
function hashId(hash: string): number | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const id = Number(hash.slice(HASH_PREFIX.length));
  return Number.isInteger(id) ? id : null;
}

// Which item is open is read from the fragment rather than mirrored into
// state, so a deep link, a Back press and a thumbnail click all arrive the same
// way. History writes notify no one, so open/navigate/close ping subscribers
// themselves; the server snapshot is empty, and the first client render after
// hydration is what opens an incoming deep link.
const listeners = new Set<() => void>();

function subscribeToHash(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("popstate", onChange);
    window.removeEventListener("hashchange", onChange);
  };
}

function writeHistory(write: () => void) {
  write();
  for (const l of listeners) l();
}

export default function MediaViewerHost({
  items: server,
  children,
}: {
  /** The build's media as the server rendered it. */
  items: BuildMediaView[];
  children: React.ReactNode;
}) {
  const [extra, setExtra] = useState<BuildMediaView[]>([]);
  // The open item, by id rather than index: an upload that finishes while the
  // viewer is open would otherwise slide the sequence under it.
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash, () => "");
  const viewing = hashId(hash);
  // Whether the open viewer owes the current history entry to open() — close()
  // then rewinds with back(); a deep-linked viewer has no entry of ours to pop
  // and rewrites the URL in place instead.
  const pushed = useRef(false);

  const items = useMemo(() => {
    const fromServer = new Set(server.map((m) => m.id));
    const all = [...server, ...extra.filter((m) => !fromServer.has(m.id))];
    // Stable, so each kind keeps the server's own order (oldest first).
    return all.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  }, [server, extra]);

  const open = useCallback((id: number) => {
    writeHistory(() => window.history.pushState(null, "", `${HASH_PREFIX}${id}`));
    pushed.current = true;
  }, []);

  const add = useCallback(
    (item: BuildMediaView) => setExtra((a) => (a.some((m) => m.id === item.id) ? a : [...a, item])),
    []
  );
  const drop = useCallback((id: number) => setExtra((a) => a.filter((m) => m.id !== id)), []);
  const patch = useCallback(
    (id: number, fields: Partial<BuildMediaView>) =>
      setExtra((a) => a.map((m) => (m.id === id ? { ...m, ...fields } : m))),
    []
  );

  const navigate = useCallback(
    (i: number) => {
      const item = items[i];
      if (!item) return;
      writeHistory(() => window.history.replaceState(null, "", `${HASH_PREFIX}${item.id}`));
    },
    [items]
  );

  const close = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      // Rewinds to the entry before the viewer opened; popstate then reports
      // the fragment-free URL and closes it.
      window.history.back();
    } else {
      const { pathname, search } = window.location;
      writeHistory(() => window.history.replaceState(null, "", `${pathname}${search}`));
    }
  }, []);

  const index = viewing === null ? -1 : items.findIndex((m) => m.id === viewing);
  const value = useMemo(() => ({ items, open, add, drop, patch }), [items, open, add, drop, patch]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {index >= 0 && <MediaViewer items={items} index={index} onClose={close} onNavigate={navigate} />}
    </Ctx.Provider>
  );
}

/** A media thumbnail that opens the gallery instead of navigating to the blob
 *  (which the bucket gateway serves under its hash, with no extension). */
export function MediaThumb({
  item,
  className,
  wrapClassName = "block",
  width,
}: {
  item: BuildMediaView;
  /** Classes for the image itself. */
  className?: string;
  /** Classes for the button around it, where the cell's own sizing goes. */
  wrapClassName?: string;
  /** Server-scaled thumb width; the original is drawn when unset. */
  width?: 500 | 1000;
}) {
  const { open } = useMedia();
  return (
    <button onClick={() => open(item.id)} title={item.filename} className={wrapClassName}>
      {/* Photos are multi-MB scans: draw the cell from the server-scaled thumb
          (lanczos) instead of making the browser downsample the original. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={width ? `/api/media/${item.sha256}/thumb?w=${width}` : item.url}
        alt={item.filename}
        loading="lazy"
        className={className}
      />
    </button>
  );
}
