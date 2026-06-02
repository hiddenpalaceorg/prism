//! Curator core — the UI-agnostic engine shared by the CLI, the native GUIs (via
//! UniFFI), and the export/ingest tooling.
//!
//! Pipeline: hash the image (Rust) → check the sha256 cache → otherwise run the
//! `ps2exe-adapter` subprocess → normalize into the canonical [`BuildRecord`] →
//! render DAT/JSON → cache + index in SQLite.

pub mod adapter;
pub mod cache;
pub mod db;
pub mod error;
pub mod fingerprint;
pub mod progress;
pub mod render;
pub mod schema;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use error::{Error, Result};
pub use progress::{Event, NoopObserver, ProgressObserver};
pub use schema::*;

use adapter::AdapterCommand;
use cache::Cache;
use db::Db;

/// Configuration for an [`Analyzer`].
pub struct Config {
    pub adapter: AdapterCommand,
    /// Override the user data dir (cache + db). `None` ⇒ platform default.
    pub data_dir: Option<PathBuf>,
}

/// The orchestrator. One per process is plenty.
pub struct Analyzer {
    cache: Cache,
    db: Db,
    adapter: AdapterCommand,
    data_dir: PathBuf,
}

/// Result of [`Analyzer::analyze`].
pub struct Analysis {
    pub record: BuildRecord,
    /// True when served from the sha256 cache (adapter not run).
    pub from_cache: bool,
    /// Path to the cached JSON.
    pub json_path: PathBuf,
}

impl Analyzer {
    pub fn new(config: Config) -> Result<Self> {
        let data_dir = match config.data_dir {
            Some(d) => {
                std::fs::create_dir_all(&d)?;
                d
            }
            None => cache::default_data_dir()?,
        };
        let cache = Cache::open(Some(&data_dir))?;
        let db = Db::open(&data_dir)?;
        Ok(Analyzer { cache, db, adapter: config.adapter, data_dir })
    }

    /// Open a lock-free read side of the library (a second DB connection + the record
    /// cache) — for a GUI's browser, so queries *and* opening a build run concurrently
    /// with an in-progress import (which holds the writer). See WAL in [`Db::open`].
    pub fn open_reader(&self) -> Result<Reader> {
        Ok(Reader {
            db: Db::open(&self.data_dir)?,
            cache: Cache::open(Some(&self.data_dir))?,
        })
    }

    /// Analyze one image/container. Idempotent: a known sha256 is served from cache.
    pub fn analyze(
        &self,
        path: &str,
        observer: Arc<dyn ProgressObserver>,
    ) -> Result<Analysis> {
        // 1. Image identity (single streaming read in Rust).
        let image = fingerprint::hash_image(path, &observer)?;

        // 2. Cache short-circuit.
        if let Some(record) = self.cache.load(&image.sha256)? {
            observer.on_event(Event::Message(format!("cache hit {}", image.sha256)));
            let json_path = self.cache.json_path(&image.sha256);
            return Ok(Analysis { record, from_cache: true, json_path });
        }

        // 3. Parse + extract via the adapter (Python/ps2exe).
        let raw = adapter::run(&self.adapter, path, observer.clone())?;
        if raw.files.is_empty() {
            return Err(Error::Unsupported(path.to_string()));
        }

        // 4. Normalize into the canonical record.
        let info = schema::DiscInfo {
            system: raw.info.system.clone(),
            system_identifier: raw.info.system_identifier.clone(),
            header: schema::Header {
                title: raw.info.header.title.clone(),
                product_number: raw.info.header.product_number.clone(),
                product_version: raw.info.header.product_version.clone(),
                release_date: raw.info.header.release_date.clone(),
                maker_id: raw.info.header.maker_id.clone(),
                device_info: raw.info.header.device_info.clone(),
                regions: raw.info.header.regions.clone(),
            },
            volume: schema::Volume {
                identifier: raw.info.volume.identifier.clone(),
                set_identifier: raw.info.volume.set_identifier.clone(),
                creation_date: raw.info.volume.creation_date.clone(),
                modification_date: raw.info.volume.modification_date.clone(),
            },
            exe: raw
                .info
                .exe
                .as_ref()
                .map(|e| schema::Exe { filename: e.filename.clone(), date: e.date.clone() }),
            disc_type: raw.info.disc_type.clone(),
        };

        let composites = fingerprint::composites(&raw.files);
        let structural = fingerprint::structural(&info.system, &raw.files);
        let text_doc = fingerprint::text_doc(&info, &raw.files);
        let chunk_signature = fingerprint::chunk_signature(&raw.files);
        let resemblance = fingerprint::resemblance_signature(&raw.files);
        let sidecar = fingerprint::chunk_sidecar(&raw.files);
        let contents = fingerprint::build_tree(&raw.files);

        let record = BuildRecord {
            record_schema_version: schema::RECORD_SCHEMA_VERSION,
            fingerprint_profile: schema::FINGERPRINT_PROFILE.to_string(),
            image,
            info,
            composites,
            structural,
            text_doc,
            contents,
            media: raw
                .media
                .iter()
                .map(|m| schema::MediaFp {
                    path: m.path.clone(),
                    kind: m.kind.clone(),
                    phash: None,
                    chromaprint: None,
                    audio_fp: m.audio_fp.clone(),
                })
                .collect(),
            exe_fp: raw.exe_fp.as_ref().and_then(|e| {
                if e.tlsh.is_none() && e.imphash.is_none() {
                    None
                } else {
                    Some(schema::ExeFp {
                        tlsh: e.tlsh.clone(),
                        imphash: e.imphash.clone(),
                        func_hashes: Vec::new(),
                    })
                }
            }),
            chunk_signature,
            resemblance,
        };

        // 5. Render, cache, index.
        let xml = render::to_dat_xml(&record);
        let json_path = self.cache.store(&record, &xml)?;
        self.cache.store_chunks(&record.image.sha256, &sidecar)?;
        self.db
            .upsert_build(&record, &json_path.to_string_lossy())?;

        Ok(Analysis { record, from_cache: false, json_path })
    }

    /// Number of builds in the local library.
    pub fn library_size(&self) -> Result<u64> {
        self.db.count_builds()
    }

    /// The most recently analyzed builds, newest first.
    pub fn recent_builds(&self, limit: u32) -> Result<Vec<db::LibraryRow>> {
        self.db.list_recent(limit)
    }

    /// Search/browse the library (name+system substring, optional system filter,
    /// sortable, paged). Backs the library browser in the GUIs.
    pub fn search_library(
        &self,
        search: Option<&str>,
        system: Option<&str>,
        sort: db::LibrarySort,
        desc: bool,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<db::LibraryRow>> {
        self.db.search_builds(search, system, sort, desc, limit, offset)
    }

    /// Distinct systems in the library (for the browser's filter control).
    pub fn library_systems(&self) -> Result<Vec<String>> {
        self.db.list_systems()
    }

    /// Reload a previously analyzed build from the sha256 cache (no adapter run).
    pub fn load_cached(&self, sha256: &str) -> Result<Option<Analysis>> {
        match self.cache.load(sha256)? {
            Some(record) => Ok(Some(Analysis {
                record,
                from_cache: true,
                json_path: self.cache.json_path(sha256),
            })),
            None => Ok(None),
        }
    }

    /// Export the library as JSON Lines (one canonical build record per line) — the
    /// bulk desktop→web contribute feed. Returns the number of records written.
    pub fn export_jsonl<W: std::io::Write>(&self, mut out: W) -> Result<u64> {
        let mut n = 0;
        for path in self.db.list_json_paths()? {
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue, // cache entry pruned; skip
            };
            // Re-emit compactly, one record per line.
            let record: BuildRecord = match serde_json::from_slice(&bytes) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("skipping unparseable cache entry {path}: {e}");
                    continue;
                }
            };
            serde_json::to_writer(&mut out, &record)?;
            out.write_all(b"\n")?;
            n += 1;
        }
        Ok(n)
    }

    /// Export the library as a portable bundle: a ZIP holding `builds.jsonl` (the
    /// JSON-Lines feed) plus a self-describing `manifest.json`. This is the format
    /// to copy between machines and ingest into the web service; it's
    /// double-clickable on macOS/Windows. Returns the number of records written.
    pub fn export_bundle(&self, path: &Path) -> Result<u64> {
        use sha2::{Digest, Sha256};
        use zip::write::SimpleFileOptions;

        let zip_err = |e: zip::result::ZipError| Error::Other(format!("zip: {e}"));
        let file = std::fs::File::create(path)?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = SimpleFileOptions::default();

        // Records first, hashing the exact bytes we store so the manifest can carry
        // an integrity digest the importer can verify.
        let n;
        let body_sha256 = {
            zip.start_file("builds.jsonl", opts).map_err(zip_err)?;
            let mut hasher = Sha256::new();
            {
                let mut hw = HashingWriter { inner: &mut zip, hasher: &mut hasher };
                n = self.export_jsonl(&mut hw)?;
            }
            hex::encode(hasher.finalize())
        };

        zip.start_file("manifest.json", opts).map_err(zip_err)?;
        let manifest = serde_json::json!({
            "curator_bundle": 1,
            "record_schema_version": schema::RECORD_SCHEMA_VERSION,
            "fingerprint_profile": schema::FINGERPRINT_PROFILE,
            "count": n,
            "tool_version": env!("CARGO_PKG_VERSION"),
            "created_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            "body_sha256": body_sha256,
        });
        serde_json::to_writer_pretty(&mut zip, &manifest)?;
        zip.finish().map_err(zip_err)?;
        Ok(n)
    }
}

/// Extensions ps2exe skips when walking a tree — mirrors `is_path_allowed` in
/// `lib/ps2exe/utils/common.py` (the source of truth; keep in sync). Folder import
/// uses this so it doesn't waste time hashing obvious non-discs, and so descriptor /
/// sidecar files (`.cue`/`.ccd`/`.sub`/…) don't import as duplicates of the disc
/// they belong to.
const NON_DISC_EXTENSIONS: &[&str] = &[
    "html", "htm", "jpeg", "jpg", "png", "bmp", "gif", "tif", "txt", "pdf", "dat", "json", "sfv",
    "sha1", "md5", "par2", "cue", "ccd", "sub", "gdi", "cdi", "raw", "c2", "subcode", "fulltoc",
    "wav", "mp3", "avi", "exe", "nfo", "part", "dctmp", "state",
];

/// Console-specific metadata blobs ps2exe always ignores (also from `is_path_allowed`).
const IGNORED_FILENAMES: &[&str] = &["ip.bin", "ss.bin", "pfi.bin", "dmi.bin"];

/// Whether `path`'s name looks like a disc image/container worth handing to the
/// adapter (vs. an obvious non-disc the adapter would reject anyway).
fn looks_importable(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
    let lower = name.to_ascii_lowercase();
    if IGNORED_FILENAMES.contains(&lower.as_str()) {
        return false;
    }
    // `Data####` split-dump metadata (e.g. Data0001), matched at the end of the name.
    if lower.len() >= 8 {
        let (head, tail) = lower.split_at(lower.len() - 4);
        if tail.bytes().all(|b| b.is_ascii_digit()) && head.ends_with("data") {
            return false;
        }
    }
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => !NON_DISC_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()),
        None => true, // extensionless files (e.g. a bare track) are worth a try
    }
}

/// Lock-free read side of the library: a second DB connection plus the on-disk record
/// cache. A GUI holds one so browsing and opening builds keep working while an import
/// holds the writer. Built by [`Analyzer::open_reader`].
pub struct Reader {
    db: Db,
    cache: Cache,
}

impl Reader {
    /// Search/browse the library — see [`Analyzer::search_library`].
    pub fn search_builds(
        &self,
        search: Option<&str>,
        system: Option<&str>,
        sort: db::LibrarySort,
        desc: bool,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<db::LibraryRow>> {
        self.db.search_builds(search, system, sort, desc, limit, offset)
    }

    /// Distinct systems present in the library.
    pub fn list_systems(&self) -> Result<Vec<String>> {
        self.db.list_systems()
    }

    /// Most recently analyzed builds, newest first.
    pub fn list_recent(&self, limit: u32) -> Result<Vec<db::LibraryRow>> {
        self.db.list_recent(limit)
    }

    /// Load a build from the record cache by sha256 (no writer lock, no adapter run).
    pub fn load_cached(&self, sha256: &str) -> Result<Option<Analysis>> {
        match self.cache.load(sha256)? {
            Some(record) => Ok(Some(Analysis {
                record,
                from_cache: true,
                json_path: self.cache.json_path(sha256),
            })),
            None => Ok(None),
        }
    }
}

/// Recursively collect importable files under `root`, depth-first, sorted for a
/// deterministic order. Non-disc files (per ps2exe's blocklist) and symlinks are
/// skipped; unreadable directories are silently skipped. Backs the GUIs' folder
/// import, which then tries to analyze each returned file and skips any that don't
/// parse. (Single-file "Open" bypasses this filter — it tries whatever you pick.)
pub fn list_importable_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => stack.push(entry.path()),
                Ok(ft) if ft.is_file() && looks_importable(&entry.path()) => out.push(entry.path()),
                _ => {} // dirs handled above; symlinks / specials / non-disc files: skip
            }
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod walk_tests {
    use super::list_importable_files;

    #[test]
    fn recurses_disc_files_skips_non_discs_and_is_sorted() {
        let root = std::env::temp_dir().join(format!("curator-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub/deep")).unwrap();
        // disc-like — kept
        std::fs::write(root.join("b.iso"), b"x").unwrap();
        std::fs::write(root.join("a.zip"), b"x").unwrap();
        std::fs::write(root.join("sub/c.bin"), b"x").unwrap();
        std::fs::write(root.join("sub/deep/game.chd"), b"x").unwrap();
        // non-disc / sidecar / metadata — skipped per ps2exe's blocklist
        std::fs::write(root.join("disc.cue"), b"x").unwrap();
        std::fs::write(root.join("readme.txt"), b"x").unwrap();
        std::fs::write(root.join("scan.jpg"), b"x").unwrap();
        std::fs::write(root.join("IP.BIN"), b"x").unwrap(); // case-insensitive
        std::fs::write(root.join("Data0001"), b"x").unwrap();

        let rel: Vec<String> = list_importable_files(&root)
            .iter()
            .map(|p| p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        assert_eq!(rel, ["a.zip", "b.iso", "sub/c.bin", "sub/deep/game.chd"]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_root_yields_empty() {
        let root = std::env::temp_dir().join("curator-walk-nope-zzz");
        let _ = std::fs::remove_dir_all(&root);
        assert!(list_importable_files(&root).is_empty());
    }
}

/// A `Write` that tees everything into a SHA-256 hasher on its way to `inner`.
struct HashingWriter<'a, W: Write> {
    inner: &'a mut W,
    hasher: &'a mut sha2::Sha256,
}

impl<W: Write> Write for HashingWriter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        use sha2::Digest;
        let written = self.inner.write(buf)?;
        self.hasher.update(&buf[..written]);
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}
