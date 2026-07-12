// The on-disk content-addressed blob store backing the asset viewer. Blobs are
// extracted by the desktop analyzer, shipped inside export bundles, and placed
// here by scripts/ingest.ts; the API route streams them out by sha256.

import path from "node:path";
import { open } from "node:fs/promises";

/** Root of the blob store. Blobs live at `<root>/<sha256[:2]>/<sha256>`. */
export function assetStoreDir(): string {
  // Default sits next to the app (survives the deploy rsync, excluded from git).
  return process.env.ASSET_STORE_DIR || path.join(process.cwd(), "asset-store");
}

/** Absolute path of one blob. Caller must have validated `sha256` (isSha256). */
export function assetBlobPath(sha256: string): string {
  return path.join(assetStoreDir(), sha256.slice(0, 2), sha256);
}

/** Display order for asset kinds on the build pages. */
export const ASSET_KIND_ORDER = ["image", "audio", "video", "text"] as const;

/** Per-kind asset counts. */
export function assetTotals(assets: { kind: string }[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const a of assets) totals[a.kind] = (totals[a.kind] ?? 0) + 1;
  return totals;
}

/** Assets regrouped in display-kind order, keeping at most `capPerKind` of each
 *  — one number for all kinds, or a per-kind map (missing kind = uncapped).
 *  Path order within a kind is preserved (getBuildAssets sorts by path). */
export function orderAssets<T extends { kind: string }>(
  assets: T[],
  capPerKind: number | Record<string, number> = Infinity
): T[] {
  const cap = (k: string) => (typeof capPerKind === "number" ? capPerKind : (capPerKind[k] ?? Infinity));
  return ASSET_KIND_ORDER.flatMap((k) => assets.filter((a) => a.kind === k).slice(0, cap(k)));
}

/** Leading bytes of a text blob decoded as lossy UTF-8 for an excerpt card, or
 *  null when the blob is missing from the store. */
export async function readAssetExcerpt(sha256: string, maxBytes = 2048): Promise<string | null> {
  let fh;
  try {
    fh = await open(assetBlobPath(sha256), "r");
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return new TextDecoder("utf-8", { fatal: false })
      .decode(buf.subarray(0, bytesRead))
      .replace(/\u0000/g, "")
      .replace(/\r\n?/g, "\n");
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
