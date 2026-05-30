// Shared fingerprint helpers for the ingester and similarity query.

const MASK63 = (1n << 63n) - 1n;

/** Stable 63-bit id from a hex content hash (for the Tier-2 file-hash set). */
export function hexToId63(hex) {
  if (!hex) return null;
  return BigInt("0x" + hex.slice(0, 16)) & MASK63;
}

/** Postgres BIGINT is signed; reinterpret a u64 bit pattern as i64. */
export function toSigned64(u) {
  return BigInt.asIntN(64, u);
}

/** LSH bands over a MinHash signature: fold each band of `r` slots to one hash. */
export function lshBands(values, b = 16, r = 8) {
  const bands = [];
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

/** Flatten the canonical contents tree into a list of file rows. */
export function flattenFiles(nodes, prefix = "") {
  const out = [];
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
export function minhashJaccard(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let eq = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++;
  return eq / a.length;
}
