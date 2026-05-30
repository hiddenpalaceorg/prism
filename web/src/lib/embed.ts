// Text embedding for the semantic similarity tier.
// Local open model (all-MiniLM-L6-v2, 384-dim) via transformers.js — no Python, no API.

import { pipeline } from "@huggingface/transformers";

export const EMBED_DIM = 384;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: Promise<any> | null = null;

function getExtractor() {
  if (!extractor) {
    extractor = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  return extractor;
}

/** Embed text into a unit-normalized 384-d vector. */
export async function embed(text: string): Promise<number[]> {
  const ex = await getExtractor();
  const out = await ex([text || ""], { pooling: "mean", normalize: true });
  return out.tolist()[0] as number[];
}

/** Format a vector as a pgvector literal: `[f1,f2,...]`. */
export function toPgVector(v: number[]): string {
  return "[" + v.join(",") + "]";
}
