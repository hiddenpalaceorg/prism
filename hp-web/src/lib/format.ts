// Dependency-free display formatters shared by the build/asset/repo UIs. Kept
// import-free so both server and client components can pull from one source
// (this was copy-pasted into ~6 components and had begun to diverge).

/** Human-readable byte size ("1.5 MB"), "—" for null/undefined. */
export function humanSize(bytes?: number | null): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
}
