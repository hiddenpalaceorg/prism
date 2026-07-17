// WAV container inspection: which codec is inside, and whether browsers
// decode it natively (<audio> and WebAudio decodeAudioData alike). Console
// builds are full of WAVs holding ADPCM variants (e.g. Xbox ADPCM, format
// tag 0x0069) that no browser plays. Those route through the PCM transcode.

// Format tags browsers ship decoders for: PCM, IEEE float, A-law, µ-law.
const BROWSER_TAGS = new Set([0x0001, 0x0003, 0x0006, 0x0007]);

/** The fmt chunk's format tag (WAVE_FORMAT_EXTENSIBLE resolved to its
 *  SubFormat code), or null when `head` doesn't parse as a WAV. `head` needs
 *  only the leading bytes of the file: the fmt chunk sits well within 2KB. */
export function wavFormatTag(head: Buffer): number | null {
  if (
    head.length < 12 ||
    head.toString("latin1", 0, 4) !== "RIFF" ||
    head.toString("latin1", 8, 12) !== "WAVE"
  ) {
    return null;
  }
  let off = 12;
  while (off + 8 <= head.length) {
    const id = head.toString("latin1", off, off + 4);
    const size = head.readUInt32LE(off + 4);
    if (id === "fmt ") {
      if (size < 2 || off + 10 > head.length) return null;
      const tag = head.readUInt16LE(off + 8);
      if (tag !== 0xfffe) return tag;
      // WAVE_FORMAT_EXTENSIBLE: the real codec is the SubFormat GUID at fmt
      // offset 24, whose first two bytes are the format tag.
      return size >= 26 && off + 34 <= head.length ? head.readUInt16LE(off + 32) : null;
    }
    off += 8 + size + (size & 1); // chunks are word-aligned
  }
  return null;
}

/** Whether browsers play this WAV natively. Unparseable headers count as
 *  playable: serving the raw bytes is the status-quo failure mode, and a
 *  transcode of a file ffmpeg can't parse either would fail anyway. */
export function wavBrowserPlayable(head: Buffer): boolean {
  const tag = wavFormatTag(head);
  return tag === null || BROWSER_TAGS.has(tag);
}
