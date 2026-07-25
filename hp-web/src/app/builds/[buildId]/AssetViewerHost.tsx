"use client";

// Single per-page owner of the asset lightbox. Anything that opens assets
// (file tree rows, gallery cards) calls open(path) via context; the host keeps
// the address bar in sync — /builds/<id>/assets/<path> while the viewer is
// open — so every asset is deep-linkable and back/forward close/reopen it.
// pushState/replaceState are shallow: Next keeps the page mounted and only
// syncs its router state, so opening an asset never refetches anything.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { assetHref, normalizeAssetPath, safeDecodeSegment } from "@/lib/slug";
import AssetViewer, { type ViewableAsset } from "./AssetViewer";

const OpenAssetCtx = createContext<((path: string) => void) | null>(null);

/** open(path) of the nearest AssetViewerHost (no-op when unhosted). */
export function useOpenAsset(): (path: string) => void {
  return useContext(OpenAssetCtx) ?? (() => {});
}

export default function AssetViewerHost({
  assets,
  buildHref,
  returnHref,
  initialPath,
  children,
}: {
  /** Every viewable asset of the build — the viewer steps through all of them. */
  assets: ViewableAsset[];
  /** Canonical /builds/<id> of the page, base of the asset deep links. */
  buildHref: string;
  /** URL restored when a deep-linked viewer closes (no history entry to pop). */
  returnHref: string;
  /** Asset to show open on first render (server-resolved deep link). */
  initialPath?: string;
  children: React.ReactNode;
}) {
  // Keyed by normalized path so stored paths (leading "/") and URL-derived
  // ones (no leading "/") both resolve.
  const indexByPath = useMemo(
    () => new Map(assets.map((a, i) => [normalizeAssetPath(a.path), i] as const)),
    [assets]
  );
  const [viewing, setViewing] = useState<number | null>(
    () => indexByPath.get(normalizeAssetPath(initialPath ?? "")) ?? null
  );
  // Whether the open viewer owes the current history entry to open() — close()
  // then rewinds with back(); a deep-linked viewer has no entry of ours to pop
  // and rewrites the URL in place instead.
  const pushed = useRef(false);

  const open = useCallback(
    (path: string) => {
      const i = indexByPath.get(normalizeAssetPath(path));
      if (i === undefined) return;
      window.history.pushState(null, "", assetHref(buildHref, path));
      pushed.current = true;
      setViewing(i);
    },
    [indexByPath, buildHref]
  );

  const navigate = useCallback(
    (i: number) => {
      const a = assets[i];
      if (!a) return;
      window.history.replaceState(null, "", assetHref(buildHref, a.path));
      setViewing(i);
    },
    [assets, buildHref]
  );

  const close = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else {
      window.history.replaceState(null, "", returnHref);
    }
    setViewing(null);
  }, [returnHref]);

  // Back/forward: re-derive the viewer from wherever the URL landed.
  useEffect(() => {
    const prefix = `${buildHref}/assets/`;
    const onPop = () => {
      const p = window.location.pathname;
      const rel = p.startsWith(prefix)
        ? p.slice(prefix.length).split("/").map(safeDecodeSegment).join("/")
        : null;
      const i = rel === null ? undefined : indexByPath.get(rel);
      if (i === undefined) {
        pushed.current = false;
        setViewing(null);
      } else {
        setViewing(i);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [buildHref, indexByPath]);

  return (
    <OpenAssetCtx.Provider value={open}>
      {children}
      {viewing !== null && assets[viewing] && (
        <AssetViewer assets={assets} index={viewing} onClose={close} onNavigate={navigate} />
      )}
    </OpenAssetCtx.Provider>
  );
}
