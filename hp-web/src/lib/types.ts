// Mirror of the canonical BuildRecord (prism-core/src/schema.rs).

export interface ImageInfo {
  name: string;
  size: number;
  md5: string;
  sha1: string;
  sha256: string;
}

export interface Composites {
  content_hash?: string;
  filtered_content_hash?: string;
  hash_exe?: string;
  incomplete_files?: number;
}

export interface Structural {
  system: string;
  file_count: number;
  total_size: number;
  max_depth: number;
  ext_histogram: Record<string, number>;
}

export type Node =
  | {
      type: "dir";
      name: string;
      date?: string;
      size?: number;
      /** Present on archives listed as directories — the archive file's own hashes. */
      md5?: string;
      sha1?: string;
      sha256?: string;
      children: Node[];
    }
  | {
      type: "file";
      name: string;
      date?: string;
      size?: number;
      md5?: string;
      sha1?: string;
      sha256?: string;
      unreadable?: boolean;
    };

export interface Signature {
  kind: string;
  k: number;
  seed: string;
  values: string[];
}

export interface BuildRecord {
  record_schema_version: number;
  fingerprint_profile: string;
  image: ImageInfo;
  info: { system: string; [k: string]: unknown };
  composites: Composites;
  structural: Structural;
  text_doc: string;
  contents: Node[];
  /** MinHash signature over the content-defined chunk set. */
  chunk_signature?: Signature | null;
  /** Byte-shingle resemblance (OPH) — robust to scattered small edits. */
  resemblance?: Signature | null;
  exe_fp?: { tlsh?: string; imphash?: string } | null;
  media?: MediaFp[];
  /** Extracted files in the blob store (viewable ones whole, the rest as head
   *  snippets). Absent = extraction never ran. */
  assets?: AssetRef[] | null;
  /** Asset-extraction generation (see prism-core ASSET_PROFILE). */
  asset_profile?: number;
}

/** One extracted asset; the bytes live in the store under `sha256`. */
export interface AssetRef {
  path: string;
  sha256: string;
  size: number;
  mime: string;
  kind: string; // "image" | "audio" | "video" | "document" | "source" | "text" | "binary" (head snippet)
}

export interface MediaFp {
  path: string;
  kind: string; // "image" | "audio"
  phash?: string;
  chromaprint?: string;
  audio_fp?: number[];
}

export interface SimilarityHit {
  sha256: string;
  name: string;
  system: string;
  jaccard?: number;
}

export interface SimilarityResult {
  identical_content: { sha256: string; name: string; system: string }[];
  shared_files: SimilarityHit[];
  similar_chunks: SimilarityHit[];
  /** Byte-shingle resemblance neighbors (scattered-edit tolerant). */
  resemblance: SimilarityHit[];
  exe_imports: { sha256: string; name: string; system: string }[];
  exe_similar: { sha256: string; name: string; system: string; distance: number }[];
  audio_neighbors: { sha256: string; name: string; system: string; matched_tracks: number; best: number }[];
}
