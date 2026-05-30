// Input validation + size caps for untrusted request bodies (resource-exhaustion guard).

import type { BuildRecord, Node } from "./types";

export const MAX_BODY_BYTES = 8_000_000;

const MAX_FILES = 200_000;
const MAX_SKETCH_VALUES = 4096;
const MAX_MEDIA = 4096;
const MAX_AUDIO_FP = 200_000;

/** True if `s` is a lowercase 64-hex sha256. */
export function isSha256(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

type ValidateResult =
  | { ok: true; record: BuildRecord }
  | { ok: false; error: string };

/** Validate an untrusted BuildRecord shape and enforce upper bounds. */
export function validateBuildRecord(rec: unknown): ValidateResult {
  if (typeof rec !== "object" || rec === null) {
    return { ok: false, error: "record must be an object" };
  }
  const r = rec as Record<string, unknown>;
  const image = r.image as Record<string, unknown> | undefined;
  const sha = image?.sha256;
  if (typeof sha !== "string" || !isSha256(sha)) {
    return { ok: false, error: "image.sha256 must be a 64-char lowercase hex string" };
  }

  // Walk the contents tree with an explicit stack; bail early past the file cap.
  const contents = r.contents;
  if (contents !== undefined && !Array.isArray(contents)) {
    return { ok: false, error: "contents must be an array" };
  }
  let fileCount = 0;
  const stack: Node[] = Array.isArray(contents) ? [...(contents as Node[])] : [];
  while (stack.length) {
    const n = stack.pop()!;
    if (n && n.type === "dir") {
      if (Array.isArray(n.children)) stack.push(...n.children);
    } else {
      fileCount++;
      if (fileCount > MAX_FILES) {
        return { ok: false, error: `contents exceeds ${MAX_FILES} files` };
      }
    }
  }

  const sketch = r.sketch as Record<string, unknown> | null | undefined;
  if (sketch && Array.isArray(sketch.values) && sketch.values.length > MAX_SKETCH_VALUES) {
    return { ok: false, error: `sketch.values exceeds ${MAX_SKETCH_VALUES} entries` };
  }

  const media = r.media;
  if (media !== undefined) {
    if (!Array.isArray(media)) {
      return { ok: false, error: "media must be an array" };
    }
    if (media.length > MAX_MEDIA) {
      return { ok: false, error: `media exceeds ${MAX_MEDIA} entries` };
    }
    for (const m of media as Array<Record<string, unknown>>) {
      const fp = m?.audio_fp;
      if (Array.isArray(fp) && fp.length > MAX_AUDIO_FP) {
        return { ok: false, error: `media[].audio_fp exceeds ${MAX_AUDIO_FP} entries` };
      }
    }
  }

  return { ok: true, record: rec as BuildRecord };
}
