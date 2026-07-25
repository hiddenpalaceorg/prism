// HTTP Range parsing shared by the routes that stream media off disk
// (the raw asset route and the MP4 transcode route).

/** One satisfiable `bytes=start-end` range, else null (serve the whole file). */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || size === 0) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  const start = a === "" ? Math.max(0, size - Number(b)) : Number(a);
  const end = a !== "" && b !== "" ? Math.min(Number(b), size - 1) : size - 1;
  if (start > end || start >= size) return null;
  return { start, end };
}
