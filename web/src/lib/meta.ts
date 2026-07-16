// Shared strings for social-preview metadata (build pages + OG card images).

import type { BuildMetaRow } from "./queries";

export function humanSize(bytes?: number | null): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${bytes} B` : `${v.toFixed(1)} ${units[i]}`;
}

/** The heading users see: the curated build name (renameable by moderators). */
export function displayTitle(m: BuildMetaRow): string {
  return m.name;
}

/** "system · date" and "N files · SIZE" facts, used as chips on the OG card. */
export function buildFacts(m: BuildMetaRow): string[] {
  const facts = [m.system || "unknown system", `${m.file_count} files`, humanSize(m.total_size)];
  const day = m.build_date?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  if (day) facts.push(day);
  return facts;
}

/** One-line unfurl description. */
export function buildDescription(m: BuildMetaRow): string {
  return buildFacts(m).join(" · ");
}
