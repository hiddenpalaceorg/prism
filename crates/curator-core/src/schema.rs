//! Canonical build record — the contract shared by the CLI, GUIs, and web ingester.
//!
//! `record_schema_version` is the serialization shape; `fingerprint_profile`
//! pins the algorithm manifest.

use serde::{Deserialize, Serialize};

/// Serialization shape of the build record. Stays at 1 during development — the
/// shape is still in flux, so additive field changes don't bump it; bump at the
/// first release boundary, once consumers must distinguish shapes.
pub const RECORD_SCHEMA_VERSION: u32 = 1;
/// Algorithm manifest in force. See `fingerprint::profile`.
pub const FINGERPRINT_PROFILE: &str = "v1";
/// Asset-extraction generation. 1 = browser-viewable kinds only (implicit in
/// records that predate the field, which deserialize to 0); 2 = also head
/// snippets (`kind: "binary"`) for every file that isn't viewable; 3 = TGA
/// classified as an image (previously a head snippet); 4 = TIFF likewise;
/// 5 = PDF and PostScript (.eps/.ps/.ai) as `kind: "document"`. A record
/// below the current value gets its assets re-extracted on the next analyze.
pub const ASSET_PROFILE: u32 = 5;

/// A fully analyzed disc image / container — image-independent and self-describing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildRecord {
    pub record_schema_version: u32,
    pub fingerprint_profile: String,

    pub image: ImageInfo,
    pub info: DiscInfo,
    pub composites: Composites,
    pub structural: Structural,
    /// Title + maker + system + filename/path corpus — embedded server-side.
    pub text_doc: String,
    pub contents: Vec<Node>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub media: Vec<MediaFp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exe_fp: Option<ExeFp>,
    /// MinHash signature over the build's content-defined chunk set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_signature: Option<Signature>,
    /// Byte-shingle resemblance signature (OPH). Survives many small scattered edits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resemblance: Option<Signature>,
    /// Files extracted into the asset store: browser-viewable ones whole
    /// (images, audio, text ≤ 20MB), everything else as a raw head snippet for
    /// the hex view. `None` = extraction never ran (pre-assets record — analyze
    /// tops it up on the next cache hit); `Some(vec![])` = ran, nothing kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<Vec<AssetRef>>,
    /// [`ASSET_PROFILE`] the assets were extracted under; analyze re-extracts
    /// when it lags the current constant, so collections backfill on re-runs.
    #[serde(default)]
    pub asset_profile: u32,
}

/// One extracted asset: where it sat on the disc and how to serve it. The blob
/// itself lives in the content-addressed store under `sha256`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetRef {
    /// Full path from the volume root — matches the record's contents tree.
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub mime: String,
    pub kind: String, // "image" | "audio" | "video" | "source" | "text" | "binary" (head snippet)
}

/// Image-level identity. `sha256` is the primary key everywhere.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageInfo {
    pub name: String,
    pub size: u64,
    pub md5: String,
    pub sha1: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiscInfo {
    pub system: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_identifier: Option<String>,
    #[serde(default, skip_serializing_if = "Header::is_empty")]
    pub header: Header,
    #[serde(default, skip_serializing_if = "Volume::is_empty")]
    pub volume: Volume,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exe: Option<Exe>,
    /// Alternate/decrypted boot executable (PSP/PS3/Xbox).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt_exe: Option<AltExe>,
    /// PARAM.SFO metadata (PSP/PS3 carry this instead of a `header`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sfo: Option<Sfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disc_type: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Header {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maker_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_info: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regions: Option<String>,
}

impl Header {
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.product_number.is_none()
            && self.product_version.is_none()
            && self.release_date.is_none()
            && self.maker_id.is_none()
            && self.device_info.is_none()
            && self.regions.is_none()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Volume {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set_identifier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modification_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expiration_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_date: Option<String>,
}

impl Volume {
    pub fn is_empty(&self) -> bool {
        self.identifier.is_none()
            && self.set_identifier.is_none()
            && self.creation_date.is_none()
            && self.modification_date.is_none()
            && self.expiration_date.is_none()
            && self.effective_date.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Exe {
    /// Absent on systems whose boot exe is identified only by parsed headers (e.g. Xbox).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// Signature class: `retail`/`debug`/`devkit`/`xex1` (PS3, Xbox, Xbox360).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signing_type: Option<String>,
    /// ELF symbol count (PS3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_symbols: Option<u64>,
}

/// Alternate/decrypted boot executable. The on-disc exe is encrypted on PSP/PS3/Xbox;
/// `md5` here is over the decrypted form, the stable cross-image identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AltExe {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub md5: Option<String>,
}

/// PARAM.SFO metadata — the only title/serial source on PSP/PS3 (no `header`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Sfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disc_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disc_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parental_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_version: Option<String>,
}

impl Sfo {
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.disc_id.is_none()
            && self.disc_version.is_none()
            && self.category.is_none()
            && self.parental_level.is_none()
            && self.system_version.is_none()
    }
}

/// Content identity: digests over the *set* of per-file content hashes,
/// independent of names, layout, order, and image container.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Composites {
    /// Over all files (strict). `None` when no file had a decodable content hash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    /// Over all files except ignored junk (`.nfo`/`.diz`/…); tolerant of cosmetic diffs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filtered_content_hash: Option<String>,
    /// md5 of the boot executable, when identified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash_exe: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub most_recent_file: Option<MostRecentFile>,
    /// Count of files that could not be fully read (bad-dump signal).
    #[serde(default)]
    pub incomplete_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MostRecentFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

/// Cheap precomputed structural query features.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Structural {
    pub system: String,
    pub file_count: u64,
    pub total_size: u64,
    pub max_depth: u32,
    /// extension -> count
    pub ext_histogram: std::collections::BTreeMap<String, u64>,
}

/// A node in the on-disc filesystem tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Node {
    Dir {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        date: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<u64>,
        children: Vec<Node>,
    },
    File {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        date: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        md5: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sha1: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sha256: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        unreadable: bool,
    },
}

impl Node {
    pub fn name(&self) -> &str {
        match self {
            Node::Dir { name, .. } | Node::File { name, .. } => name,
        }
    }
}

/// Perceptual media fingerprint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaFp {
    pub path: String,
    pub kind: String, // "image" | "audio"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chromaprint: Option<String>,
    /// Acoustic sub-fingerprint set for audio tracks (Jaccard-comparable).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub audio_fp: Vec<u64>,
}

/// Executable binary-similarity fingerprint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExeFp {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tlsh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imphash: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub func_hashes: Vec<String>,
}

/// MinHash signature over a set (chunks or shingles), size/IDF-aware server-side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signature {
    pub kind: String, // e.g. "minhash-v1"
    pub k: u32,
    #[serde(with = "u64_str")]
    pub seed: u64,
    /// 64-bit values serialized as JSON strings (numbers would lose precision in JS).
    #[serde(with = "u64_str_vec")]
    pub values: Vec<u64>,
}

/// Serialize a single `u64` as a JSON string.
mod u64_str {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        String::deserialize(d)?.parse().map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_u64s_serialize_as_strings_and_roundtrip() {
        let s = Signature { kind: "minhash-v1".into(), k: 2, seed: 42, values: vec![1, u64::MAX] };
        let j = serde_json::to_string(&s).unwrap();
        // u64s must be JSON strings (numbers would lose precision in JS).
        assert!(j.contains("\"42\""), "{j}");
        assert!(j.contains("\"18446744073709551615\""), "{j}");
        let back: Signature = serde_json::from_str(&j).unwrap();
        assert_eq!(back.seed, 42);
        assert_eq!(back.values, vec![1, u64::MAX]);
    }

    #[test]
    fn empty_header_and_volume_are_skipped() {
        let rec = BuildRecord {
            record_schema_version: RECORD_SCHEMA_VERSION,
            fingerprint_profile: FINGERPRINT_PROFILE.into(),
            image: ImageInfo { name: "x".into(), size: 1, md5: "m".into(), sha1: "s".into(), sha256: "h".into() },
            info: DiscInfo::default(),
            composites: Composites::default(),
            structural: Structural::default(),
            text_doc: String::new(),
            contents: vec![],
            media: vec![],
            exe_fp: None,
            chunk_signature: None,
            resemblance: None,
            assets: None,
            asset_profile: 0,
        };
        let j = serde_json::to_string(&rec).unwrap();
        assert!(!j.contains("\"header\""), "empty header should be skipped: {j}");
        assert!(!j.contains("\"chunk_signature\""));
        let back: BuildRecord = serde_json::from_str(&j).unwrap();
        assert_eq!(back.image.sha256, "h");
    }
}

/// Serialize a `Vec<u64>` as a JSON array of strings.
mod u64_str_vec {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<S: Serializer>(v: &[u64], s: S) -> Result<S::Ok, S::Error> {
        let strs: Vec<String> = v.iter().map(|x| x.to_string()).collect();
        strs.serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u64>, D::Error> {
        Vec::<String>::deserialize(d)?
            .iter()
            .map(|s| s.parse().map_err(serde::de::Error::custom))
            .collect()
    }
}
