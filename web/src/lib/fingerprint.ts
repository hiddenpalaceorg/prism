// Fingerprint helpers shared by the ingester and the API routes.

import type { BuildRecord, Node } from "./types";

const MASK63 = (1n << 63n) - 1n;

/** Stable 63-bit id from a hex content hash (for the Tier-2 file-hash set). */
export function hexToId63(hex?: string | null): bigint | null {
  if (!hex) return null;
  return BigInt("0x" + hex.slice(0, 16)) & MASK63;
}

/** Postgres BIGINT is signed; reinterpret a u64 bit pattern as i64. */
export function toSigned64(u: bigint): bigint {
  return BigInt.asIntN(64, u);
}

/** LSH bands over a MinHash signature: fold each band of `r` slots to one hash. */
export function lshBands(values: bigint[], b = 16, r = 8): bigint[] {
  const bands: bigint[] = [];
  for (let band = 0; band < b; band++) {
    let h = 1469598103934665603n; // FNV-1a 64
    for (let i = 0; i < r; i++) {
      const v = values[band * r + i] ?? 0n;
      h = BigInt.asUintN(64, (h ^ v) * 1099511628211n);
    }
    bands.push(toSigned64(h));
  }
  return bands;
}

export interface FileRow {
  path: string;
  name: string;
  size: number | null;
  md5?: string;
  sha1?: string;
  sha256?: string;
}

/** Flatten the canonical contents tree into a list of file rows. */
export function flattenFiles(nodes: Node[] | undefined, prefix = ""): FileRow[] {
  const out: FileRow[] = [];
  for (const n of nodes ?? []) {
    const path = prefix + "/" + n.name;
    if (n.type === "dir") {
      out.push(...flattenFiles(n.children, path));
    } else {
      out.push({ path, name: n.name, size: n.size ?? null, md5: n.md5, sha1: n.sha1, sha256: n.sha256 });
    }
  }
  return out;
}

/** Estimate Jaccard from two MinHash signatures (fraction of agreeing slots). */
export function minhashJaccard(a: Array<string | bigint>, b: Array<string | bigint>): number {
  if (!a || !b || a.length !== b.length) return 0;
  let eq = 0;
  for (let i = 0; i < a.length; i++) if (String(a[i]) === String(b[i])) eq++;
  return eq / a.length;
}

export interface QueryFeatures {
  sha256: string | null;
  name: string | null;
  content_hash: string | null;
  fileset: string[];
  minhash: string[] | null;
  bands: string[] | null;
}

/** Derive the query features the similarity endpoint needs from a BuildRecord. */
export function deriveQueryFeatures(rec: BuildRecord): QueryFeatures {
  const files = flattenFiles(rec.contents);
  const fileset = [
    ...new Set(
      files
        .map((f) => hexToId63(f.sha1))
        .filter((x): x is bigint => x !== null)
        .map(String)
    ),
  ];
  let minhash: string[] | null = null;
  let bands: string[] | null = null;
  if (rec.sketch?.values?.length) {
    const mh = rec.sketch.values.map((v) => toSigned64(BigInt(v)));
    minhash = mh.map(String);
    bands = lshBands(mh).map(String);
  }
  return {
    sha256: rec.image?.sha256 ?? null,
    name: rec.image?.name ?? null,
    content_hash: rec.composites?.content_hash ?? null,
    fileset,
    minhash,
    bands,
  };
}

export const arrayLit = (a: Array<string | number | bigint>): string => "{" + a.join(",") + "}";
