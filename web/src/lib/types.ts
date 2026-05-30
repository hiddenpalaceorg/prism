// Mirror of the canonical BuildRecord (curator-core/src/schema.rs).

export interface ImageInfo {
  name: string;
  size: number;
  md5: string;
  sha1: string;
  sha256: string;
}

export interface Composites {
  content_hash: string;
  filtered_content_hash: string;
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
  | { type: "dir"; name: string; date?: string; size?: number; children: Node[] }
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

export interface Sketch {
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
  sketch?: Sketch | null;
  exe_fp?: { tlsh?: string; imphash?: string } | null;
  media?: MediaFp[];
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
  tier1_twins: { sha256: string; name: string; system: string }[];
  tier2: SimilarityHit[];
  tier3: SimilarityHit[];
  tier5_exe: { sha256: string; name: string; system: string }[];
  tier5_tlsh: { sha256: string; name: string; system: string; distance: number }[];
  audio_neighbors: { sha256: string; name: string; system: string; matched_tracks: number; best: number }[];
}
