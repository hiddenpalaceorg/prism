// Hex renderings of raw asset bytes (client- and server-safe, no node deps).
// Display-side only: the store keeps the raw head bytes of unidentified files,
// so these layouts can change without re-analyzing any collection.

/** Compact spaced hex pairs ("4d 5a 90 00 …") for gallery preview cards. */
export function hexPreview(bytes: Uint8Array, maxBytes = 96): string {
  const n = Math.min(bytes.length, maxBytes);
  const pairs: string[] = [];
  for (let i = 0; i < n; i++) pairs.push(bytes[i].toString(16).padStart(2, "0"));
  return pairs.join(" ") + (bytes.length > n ? " …" : "");
}

/** Classic xxd layout: 8-hex offset, 16 bytes as 2-byte groups, ASCII gutter. */
export function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const row = bytes.subarray(off, off + 16);
    let hex = "";
    for (let j = 0; j < 16; j++) {
      hex += j < row.length ? row[j].toString(16).padStart(2, "0") : "  ";
      if (j % 2 === 1) hex += " ";
    }
    let ascii = "";
    for (const b of row) ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
    lines.push(`${off.toString(16).padStart(8, "0")}: ${hex} ${ascii}`);
  }
  return lines.join("\n");
}
