//! Canonical build record — the contract shared by the CLI, GUIs, and web ingester.
//!
//! See PLAN.md → "Build record — final output shape" and "Schema & fingerprint
//! versioning". `record_schema_version` is the serialization shape; `fingerprint_profile`
//! pins the algorithm manifest.

use serde::{Deserialize, Serialize};

/// Serialization shape of the build record. Bump on additive field changes.
pub const RECORD_SCHEMA_VERSION: u32 = 1;
/// Algorithm manifest in force. See `fingerprint::profile`.
pub const FINGERPRINT_PROFILE: &str = "v1";

/// A fully analyzed disc image / container — image-independent and self-describing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildRecord {
    pub record_schema_version: u32,
    pub fingerprint_profile: String,

    pub image: ImageInfo,
    pub info: DiscInfo,
    pub composites: Composites,
    pub structural: Structural,
    /// Title + maker + system + filename/path corpus — embedded server-side (Tier text).
    pub text_doc: String,
    pub contents: Vec<Node>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub media: Vec<MediaFp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exe_fp: Option<ExeFp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sketch: Option<Sketch>,
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
}

impl Volume {
    pub fn is_empty(&self) -> bool {
        self.identifier.is_none()
            && self.set_identifier.is_none()
            && self.creation_date.is_none()
            && self.modification_date.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Exe {
    pub filename: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
}

/// Tier-1 content identity: digests over the *set* of per-file content hashes,
/// independent of names, layout, order, and image container.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Composites {
    /// Over all files (strict).
    pub content_hash: String,
    /// Over all files except ignored junk (`.nfo`/`.diz`/…); tolerant of cosmetic diffs.
    pub filtered_content_hash: String,
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

/// Cheap precomputed query features (Tier structural).
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

/// Tier-4 perceptual media fingerprint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaFp {
    pub path: String,
    pub kind: String, // "image" | "audio"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chromaprint: Option<String>,
}

/// Tier-5 executable binary-similarity fingerprint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExeFp {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tlsh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imphash: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub func_hashes: Vec<String>,
}

/// Tier-3 weighted-MinHash sketch over the chunk set (size/IDF-aware server-side).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sketch {
    pub kind: String, // e.g. "weighted-minhash"
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
