// TLSH distance between two hex digests. Ported from the TLSH algorithm and
// validated to match py-tlsh exactly (a↔a=0, a↔b=14, a↔c=310 on reference inputs).

const swap = (b: number) => ((b & 0x0f) << 4) | ((b & 0xf0) >> 4);

interface Parsed {
  checksum: number;
  lvalue: number;
  q1: number;
  q2: number;
  code: number[];
}

function parse(input: string): Parsed | null {
  let s = input;
  if (s.startsWith("T1") || s.startsWith("t1")) s = s.slice(2);
  if (s.length < 70) return null; // 35 bytes (1-byte checksum variant)
  const bytes: number[] = [];
  for (let i = 0; i < 70; i += 2) bytes.push(parseInt(s.slice(i, i + 2), 16));
  const qb = swap(bytes[2]);
  const code: number[] = [];
  for (let i = 0; i < 32; i++) code.push(bytes[3 + 31 - i]); // body stored reversed
  return { checksum: swap(bytes[0]), lvalue: swap(bytes[1]), q1: (qb >> 4) & 0x0f, q2: qb & 0x0f, code };
}

const modDiff = (x: number, y: number, R: number) =>
  Math.min((x - y + R) % R, (y - x + R) % R);

function bytePairDiff(a: number, b: number): number {
  let diff = 0;
  for (let k = 0; k < 4; k++) {
    const d = Math.abs((a & 3) - (b & 3));
    diff += d === 3 ? 6 : d;
    a >>= 2;
    b >>= 2;
  }
  return diff;
}

/** TLSH total distance (lower = more similar). Returns null if a digest is unparseable. */
export function tlshDiff(s1: string, s2: string, lenDiff = true): number | null {
  const a = parse(s1);
  const b = parse(s2);
  if (!a || !b) return null;
  let diff = 0;
  if (lenDiff) {
    const ld = modDiff(a.lvalue, b.lvalue, 256);
    diff += ld <= 1 ? ld : ld * 12;
  }
  const q1d = modDiff(a.q1, b.q1, 16);
  diff += q1d <= 1 ? q1d : (q1d - 1) * 12;
  const q2d = modDiff(a.q2, b.q2, 16);
  diff += q2d <= 1 ? q2d : (q2d - 1) * 12;
  if (a.checksum !== b.checksum) diff += 1;
  for (let i = 0; i < 32; i++) diff += bytePairDiff(a.code[i], b.code[i]);
  return diff;
}
