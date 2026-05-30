//! Image hashing, content composites, structural features, and tree building.
//!
//! Per-file content access (for chunking / media / exe fingerprints — Tiers 3–5) lives
//! in the adapter, where file bytes are extractable. This module covers everything
//! derivable in Rust from the image bytes and the adapter's per-file hashes.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::sync::Arc;

use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::adapter::RawFile;
use crate::error::Result;
use crate::progress::{Event, ProgressObserver};
use crate::schema::*;

const READ_CHUNK: usize = 4 * 1024 * 1024;

/// Files excluded from `filtered_content_hash` and similarity (scene junk).
pub fn is_ignored(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".nfo") || lower.ends_with(".diz")
}

/// Stream the image once, computing md5/sha1/sha256 and emitting progress.
pub fn hash_image(path: &str, observer: &Arc<dyn ProgressObserver>) -> Result<ImageInfo> {
    let name = std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    let mut file = File::open(path)?;
    let size = file.metadata()?.len();

    const ID: u64 = 0;
    observer.on_event(Event::CounterOpen {
        id: ID,
        label: format!("Hashing image {name}"),
        unit: "B".into(),
        total: Some(size as f64),
    });

    let mut md5 = Md5::new();
    let mut sha1 = Sha1::new();
    let mut sha256 = Sha256::new();
    let mut buf = vec![0u8; READ_CHUNK];
    let mut done: u64 = 0;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        md5.update(&buf[..n]);
        sha1.update(&buf[..n]);
        sha256.update(&buf[..n]);
        done += n as u64;
        observer.on_event(Event::Progress { id: ID, count: done as f64 });
    }
    observer.on_event(Event::CounterClose { id: ID });

    Ok(ImageInfo {
        name,
        size,
        md5: hex::encode(md5.finalize()),
        sha1: hex::encode(sha1.finalize()),
        sha256: hex::encode(sha256.finalize()),
    })
}

/// Tier-1 content composites from the adapter's per-file sha1s.
///
/// `content_*` is a sha256 over each file's sha1 digest, sorted by digest value, so it
/// is independent of names, layout, order, and image container.
pub fn composites(files: &[RawFile]) -> Composites {
    let mut all: Vec<[u8; 20]> = Vec::new();
    let mut filtered: Vec<[u8; 20]> = Vec::new();
    let mut incomplete: u32 = 0;

    for f in files {
        if f.is_dir {
            continue;
        }
        if f.unreadable {
            incomplete += 1;
        }
        let Some(sha1_hex) = f.sha1.as_deref() else { continue };
        let Some(bytes) = decode_sha1(sha1_hex) else { continue };
        all.push(bytes);
        if !is_ignored(&f.path) {
            filtered.push(bytes);
        }
    }

    Composites {
        content_hash: digest_of_set(&mut all),
        filtered_content_hash: digest_of_set(&mut filtered),
        hash_exe: None,
        most_recent_file: None,
        incomplete_files: incomplete,
    }
}

fn decode_sha1(hex_str: &str) -> Option<[u8; 20]> {
    let v = hex::decode(hex_str).ok()?;
    v.try_into().ok()
}

fn digest_of_set(digests: &mut [[u8; 20]]) -> String {
    digests.sort_unstable();
    let mut h = Sha256::new();
    for d in digests.iter() {
        h.update(d);
    }
    hex::encode(h.finalize())
}

/// Cheap precomputed query features.
pub fn structural(system: &str, files: &[RawFile]) -> Structural {
    let mut file_count = 0u64;
    let mut total_size = 0u64;
    let mut max_depth = 0u32;
    let mut ext_histogram: BTreeMap<String, u64> = BTreeMap::new();

    for f in files {
        let depth = f.path.trim_matches('/').split('/').count() as u32;
        max_depth = max_depth.max(depth);
        if f.is_dir {
            continue;
        }
        file_count += 1;
        total_size += f.size.unwrap_or(0);
        if let Some(ext) = extension(&f.path) {
            *ext_histogram.entry(ext).or_insert(0) += 1;
        }
    }

    Structural { system: system.to_string(), file_count, total_size, max_depth, ext_histogram }
}

fn extension(path: &str) -> Option<String> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let dot = name.rfind('.')?;
    if dot == 0 {
        return None;
    }
    Some(name[dot + 1..].to_ascii_lowercase())
}

/// Title + maker + system + the full filename/path corpus, for server-side embedding.
pub fn text_doc(info: &DiscInfo, files: &[RawFile]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(t) = &info.header.title {
        parts.push(t.clone());
    }
    if let Some(m) = &info.header.maker_id {
        parts.push(m.clone());
    }
    parts.push(info.system.clone());
    for f in files {
        parts.push(f.path.trim_matches('/').replace('/', " "));
    }
    parts.join(" ")
}

// ---- Tier-3: chunk sketch + sidecar ----

const SKETCH_K: u32 = 128;
const SKETCH_BASE_SEED: u64 = 0x5ec0_de5e_ed5e_ed00;

/// MinHash sketch over the build's chunk multiset (Tier-3). `None` if no file was
/// chunked. The server recomputes an IDF/size-weighted sketch from the raw chunk set;
/// this is the cheap desktop-side approximation.
pub fn chunk_sketch(files: &[RawFile]) -> Option<Sketch> {
    let mut any = false;
    let mut mins = vec![u64::MAX; SKETCH_K as usize];
    let seeds: Vec<u64> = (0..SKETCH_K)
        .map(|i| splitmix(SKETCH_BASE_SEED ^ (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)))
        .collect();

    for f in files {
        for (hash, _len) in &f.chunks {
            any = true;
            for (i, seed) in seeds.iter().enumerate() {
                let h = splitmix(hash ^ seed);
                if h < mins[i] {
                    mins[i] = h;
                }
            }
        }
    }

    if !any {
        return None;
    }
    Some(Sketch {
        kind: "minhash-v1".into(),
        k: SKETCH_K,
        seed: SKETCH_BASE_SEED,
        values: mins,
    })
}

#[inline]
fn splitmix(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Compact binary chunk sidecar (`<sha256>.chunks`): per-file `(hash64, len)` lists,
/// retained for server-side IDF re-weighting and Tier-4 diff.
///
/// Layout (LE): magic "CCK1", u32 file_count, then per file:
/// u16 path_len, path bytes, u32 n_chunks, n_chunks × (u64 hash, u32 len).
pub fn chunk_sidecar(files: &[RawFile]) -> Vec<u8> {
    let with_chunks: Vec<&RawFile> = files.iter().filter(|f| !f.chunks.is_empty()).collect();
    let mut out = Vec::new();
    out.extend_from_slice(b"CCK1");
    out.extend_from_slice(&(with_chunks.len() as u32).to_le_bytes());
    for f in with_chunks {
        let path = f.path.as_bytes();
        let plen = path.len().min(u16::MAX as usize) as u16;
        out.extend_from_slice(&plen.to_le_bytes());
        out.extend_from_slice(&path[..plen as usize]);
        out.extend_from_slice(&(f.chunks.len() as u32).to_le_bytes());
        for (hash, len) in &f.chunks {
            out.extend_from_slice(&hash.to_le_bytes());
            out.extend_from_slice(&len.to_le_bytes());
        }
    }
    out
}

// ---- tree building ----

#[derive(Default)]
struct DirBuild {
    date: Option<String>,
    size: Option<u64>,
    dirs: BTreeMap<String, DirBuild>,
    files: BTreeMap<String, Node>,
}

/// Build the nested filesystem tree from the adapter's flat path list.
pub fn build_tree(files: &[RawFile]) -> Vec<Node> {
    let mut root = DirBuild::default();

    for f in files {
        let comps: Vec<&str> = f.path.trim_matches('/').split('/').filter(|s| !s.is_empty()).collect();
        if comps.is_empty() {
            continue;
        }
        let (name, parents) = comps.split_last().unwrap();

        let mut cur = &mut root;
        for p in parents {
            cur = cur.dirs.entry((*p).to_string()).or_default();
        }

        if f.is_dir {
            let d = cur.dirs.entry((*name).to_string()).or_default();
            d.date = f.date.clone();
            d.size = f.size;
        } else {
            cur.files.insert(
                (*name).to_string(),
                Node::File {
                    name: (*name).to_string(),
                    date: f.date.clone(),
                    size: f.size,
                    md5: f.md5.clone(),
                    sha1: f.sha1.clone(),
                    sha256: f.sha256.clone(),
                    unreadable: f.unreadable,
                },
            );
        }
    }

    finish_dir(root)
}

fn finish_dir(d: DirBuild) -> Vec<Node> {
    // Directories first, then files; each alphabetical (BTreeMap keeps key order).
    let mut out: Vec<Node> = Vec::with_capacity(d.dirs.len() + d.files.len());
    for (name, sub) in d.dirs {
        let date = sub.date.clone();
        let size = sub.size;
        out.push(Node::Dir { name, date, size, children: finish_dir(sub) });
    }
    out.extend(d.files.into_values());
    out
}
