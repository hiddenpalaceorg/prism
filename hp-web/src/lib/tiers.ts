// Tier definitions + weighted fusion for the unified "similar builds" ranking.
// Client-safe: pure data + math, no DB imports (so the filter UI can import it).

export type TierKey =
  | "content"
  | "files"
  | "chunks"
  | "resemblance"
  | "audio"
  | "text"
  | "imphash"
  | "tlsh";

export interface TierDef {
  key: TierKey;
  label: string;
  /** Portion of the 100% fused score this tier contributes when fully matched. */
  weight: number;
}

// Weights sum to 1.0. Precise identity/overlap tiers count most; fuzzy & auxiliary
// signals less. Tune here — both the ranking and the filter chips read from this.
export const TIERS: TierDef[] = [
  { key: "content", label: "Identical content", weight: 0.25 },
  { key: "files", label: "Shared files", weight: 0.2 },
  { key: "chunks", label: "Similar chunks", weight: 0.15 },
  { key: "resemblance", label: "Resembling content", weight: 0.15 },
  { key: "audio", label: "Shared audio", weight: 0.1 },
  { key: "text", label: "Semantic (text)", weight: 0.05 },
  { key: "imphash", label: "Same boot imports", weight: 0.05 },
  { key: "tlsh", label: "Similar executable", weight: 0.05 },
];

/** One candidate build with its per-tier similarity (each in [0,1]) and the set of
 *  tiers it has the underlying data for (`caps`). */
export interface FusedBuild {
  sha256: string;
  name: string;
  system: string;
  scores: Partial<Record<TierKey, number>>;
  caps: TierKey[];
}

/**
 * Tiers that count for a pair: user-active AND supported by *both* builds. A tier
 * neither build can be compared on (e.g. neither has an exe) is dropped entirely —
 * never penalized as a 0 — so it's as if its weight didn't exist for this pair.
 */
export function applicableTiers(
  active: Set<TierKey>,
  queryCaps: Iterable<TierKey>,
  neighborCaps: Iterable<TierKey>
): Set<TierKey> {
  const q = queryCaps instanceof Set ? queryCaps : new Set(queryCaps);
  const out = new Set<TierKey>();
  for (const t of neighborCaps) if (active.has(t) && q.has(t)) out.add(t);
  return out;
}

/**
 * Weighted fusion over the `applicable` tiers, renormalized so their weights span
 * 100%. Pass the result of {@link applicableTiers}; with all tiers active and both
 * builds fully capable this is the plain weighted-portion score.
 */
export function fusedScore(scores: Partial<Record<TierKey, number>>, applicable: Set<TierKey>): number {
  let num = 0;
  let den = 0;
  for (const t of TIERS) {
    if (!applicable.has(t.key)) continue;
    den += t.weight;
    num += t.weight * (scores[t.key] ?? 0);
  }
  return den > 0 ? num / den : 0;
}
