// Asset-domain helpers over the content-addressed blob store (blobstore.ts).
// Blobs are extracted by the desktop analyzer, shipped inside export bundles,
// and stored by scripts/ingest.ts; the API routes stream them out by sha256.

import { readBlobHead } from "./blobstore";
import { hexPreview } from "./hexdump";

// Path helpers re-exported for the store-layout consumers (staging, tests).
export { assetBlobPath, assetStagingPath, assetStoreDir } from "./blobstore";

/** Display order for asset kinds on the build pages. */
export const ASSET_KIND_ORDER = ["image", "audio", "video", "document", "source", "text", "binary"] as const;

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

/** Leading bytes of a blob, or null when it is missing from the store. */
export async function readAssetBytes(sha256: string, maxBytes = 2048): Promise<Buffer | null> {
  return readBlobHead(sha256, maxBytes);
}

/** Leading bytes of a text blob decoded as lossy UTF-8 for an excerpt card, or
 *  null when the blob is missing from the store. */
export async function readAssetExcerpt(sha256: string, maxBytes = 2048): Promise<string | null> {
  const buf = await readAssetBytes(sha256, maxBytes);
  if (buf === null) return null;
  return new TextDecoder("utf-8", { fatal: false })
    .decode(buf)
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n");
}

/** Kinds whose gallery cards carry a server-read preview of the blob's head. */
const EXCERPT_KINDS = new Set(["source", "text", "binary"]);

/** path -> preview text for the gallery cards: a lossy-UTF-8 excerpt for
 *  source/text, spaced hex pairs for binary head snippets. Reads are tiny but
 *  `cap` bounds them on builds with pathological file counts. */
export async function assetExcerpts(
  assets: { path: string; sha256: string; kind: string }[],
  cap = Infinity
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      assets
        .filter((a) => EXCERPT_KINDS.has(a.kind))
        .slice(0, cap)
        .map(async (a) => {
          if (a.kind === "binary") {
            const bytes = await readAssetBytes(a.sha256, 96);
            return [a.path, bytes ? hexPreview(bytes) : ""] as const;
          }
          return [a.path, (await readAssetExcerpt(a.sha256)) ?? ""] as const;
        })
    )
  );
}
