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

use std::path::PathBuf;
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
        Ok(Analyzer { cache, db, adapter: config.adapter })
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

    /// Number of builds in the local catalog.
    pub fn catalog_size(&self) -> Result<u64> {
        self.db.count_builds()
    }

    /// The most recently analyzed builds, newest first.
    pub fn recent_builds(&self, limit: u32) -> Result<Vec<db::CatalogRow>> {
        self.db.list_recent(limit)
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

    /// Export the catalog as JSON Lines (one canonical build record per line) — the
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
}
