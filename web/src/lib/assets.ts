// Asset-domain helpers over the content-addressed blob store (blobstore.ts).
// Blobs are extracted by the desktop analyzer, shipped inside export bundles,
// and stored by scripts/ingest.ts; the API routes stream them out by sha256.

import { readBlobHead } from "./blobstore";
import { hexPreview } from "./hexdump";

// Path helpers re-exported for the store-layout consumers (staging, tests).
export { assetBlobPath, assetStagingPath, assetStoreDir } from "./blobstore";

/** Public gateway URL for one blob when ASSET_PUBLIC_BASE points at a host
 *  serving the bucket's key layout directly (`<base>/<sha256[:2]>/<sha256>`),
 *  else null (serve through the app). Only media that browsers render from a
 *  sniffed body qualifies — the gateway has no extensions to type by, so
 *  text/PDF display and download filenames still need the app's headers. SVG
 *  is excluded: opened as a document on the gateway origin it could script,
 *  and there is no CSP sandbox out there. */
export function publicAssetUrl(sha256: string, mime: string): string | null {
  const base = process.env.ASSET_PUBLIC_BASE;
  if (!base) return null;
  if (!/^(image|audio|video)\/[\w.+-]+$/.test(mime) || mime === "image/svg+xml") return null;
  return `${base.replace(/\/+$/, "")}/${sha256.slice(0, 2)}/${sha256}`;
}

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

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Month buckets for the game pages' asset timeline: chronological
 *  "YYYY-MM" keys (labelled "March 2003"), assets without a parseable
 *  file date last under "Undated". Order within a bucket is preserved. */
export function assetMonths<T extends { file_date: string | null }>(
  assets: T[]
): { key: string; label: string; assets: T[] }[] {
  const by = new Map<string, T[]>();
  for (const a of assets) {
    const m = a.file_date?.match(/^(\d{4})-(\d{2})/);
    const key = m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${m[2]}` : "undated";
    let bucket = by.get(key);
    if (!bucket) by.set(key, (bucket = []));
    bucket.push(a);
  }
  const keys = [...by.keys()].filter((k) => k !== "undated").sort();
  if (by.has("undated")) keys.push("undated");
  return keys.map((key) => ({
    key,
    label: key === "undated" ? "Undated" : `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`,
    assets: by.get(key)!,
  }));
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
