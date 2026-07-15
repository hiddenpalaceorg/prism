//! UniFFI bridge: a thin, UI-agnostic facade over [`curator_core`] for native
//! front-ends. The Rust core does the work; this layer only marshals types and
//! relays progress through a foreign callback.
//!
//! Generate Swift bindings from the built dylib:
//! ```sh
//! cargo build -p curator-ffi
//! cargo run -p curator-ffi --bin uniffi-bindgen -- generate \
//!     --library target/debug/libcurator_ffi.dylib --language swift --out-dir macos/Generated
//! ```

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use curator_core::adapter::AdapterCommand;
use curator_core::{render, Analysis, Analyzer, Config, Event, Node, ProgressObserver};

uniffi::setup_scaffolding!();

// ---- Errors ----

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum CuratorError {
    #[error("cancelled")]
    Cancelled,
    #[error("{message}")]
    Failed { message: String },
}

impl From<curator_core::Error> for CuratorError {
    fn from(e: curator_core::Error) -> Self {
        match e {
            curator_core::Error::Cancelled => CuratorError::Cancelled,
            other => CuratorError::Failed { message: other.to_string() },
        }
    }
}

// ---- Value types returned to the UI ----

/// One node of the on-disc filesystem tree (recursive via `children`).
#[derive(uniffi::Record)]
pub struct FileNode {
    pub name: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub date: Option<String>,
    pub md5: Option<String>,
    pub sha1: Option<String>,
    pub sha256: Option<String>,
    pub unreadable: bool,
    pub children: Vec<FileNode>,
}

/// One browser-viewable asset extracted from the build (image/audio/video/text).
#[derive(uniffi::Record)]
pub struct AssetInfo {
    /// Full path from the volume root — matches the contents tree.
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub mime: String,
    pub kind: String, // "image" | "audio" | "video" | "source" | "text"
    /// Absolute path of the blob in the local store, when present.
    pub blob_path: Option<String>,
}

/// Everything the GUI needs to render one analyzed image.
#[derive(uniffi::Record)]
pub struct AnalysisSummary {
    pub sha256: String,
    pub name: String,
    pub system: String,
    pub title: Option<String>,
    pub from_cache: bool,
    pub file_count: u64,
    pub total_size: u64,
    pub json_path: String,
    pub tree: Vec<FileNode>,
    /// Pretty-printed canonical XML DAT.
    pub xml: String,
    /// Pretty-printed canonical JSON record.
    pub json: String,
    /// Viewable assets. `None` = extraction never ran on this record.
    pub assets: Option<Vec<AssetInfo>>,
}

/// Column the library browser sorts on.
#[derive(uniffi::Enum)]
pub enum LibrarySort {
    Name,
    System,
    Files,
    Size,
    Date,
}

impl From<LibrarySort> for curator_core::db::LibrarySort {
    fn from(s: LibrarySort) -> Self {
        match s {
            LibrarySort::Name => curator_core::db::LibrarySort::Name,
            LibrarySort::System => curator_core::db::LibrarySort::System,
            LibrarySort::Files => curator_core::db::LibrarySort::Files,
            LibrarySort::Size => curator_core::db::LibrarySort::Size,
            LibrarySort::Date => curator_core::db::LibrarySort::Date,
        }
    }
}

/// A library entry for the recent-builds list and the library browser.
#[derive(uniffi::Record)]
pub struct LibraryEntry {
    pub sha256: String,
    pub name: String,
    pub system: String,
    pub file_count: u64,
    pub total_size: u64,
    /// Unix seconds of last analysis.
    pub analyzed_at: i64,
}

/// Assemble the UI summary from a canonical record (shared by analyze + loadBuild).
/// `blob_path` resolves an asset sha256 to its local blob, when present.
fn build_summary(
    analysis: &Analysis,
    blob_path: impl Fn(&str) -> Option<std::path::PathBuf>,
) -> Result<AnalysisSummary, CuratorError> {
    let record = &analysis.record;
    let xml = render::to_dat_xml(record);
    let json = render::to_json(record).map_err(CuratorError::from)?;
    let assets = record.assets.as_ref().map(|assets| {
        assets
            .iter()
            .map(|a| AssetInfo {
                path: a.path.clone(),
                sha256: a.sha256.clone(),
                size: a.size,
                mime: a.mime.clone(),
                kind: a.kind.clone(),
                blob_path: blob_path(&a.sha256).map(|p| p.to_string_lossy().into_owned()),
            })
            .collect()
    });
    Ok(AnalysisSummary {
        sha256: record.image.sha256.clone(),
        name: record.image.name.clone(),
        system: record.info.system.clone(),
        title: record.info.header.title.clone(),
        from_cache: analysis.from_cache,
        file_count: record.structural.file_count,
        total_size: record.structural.total_size,
        json_path: analysis.json_path.to_string_lossy().into_owned(),
        tree: record.contents.iter().map(node_to_ffi).collect(),
        xml,
        json,
        assets,
    })
}

fn entry_from_row(r: curator_core::db::LibraryRow) -> LibraryEntry {
    LibraryEntry {
        sha256: r.sha256,
        name: r.name,
        system: r.system,
        file_count: r.file_count,
        total_size: r.total_size,
        analyzed_at: r.analyzed_at,
    }
}

fn node_to_ffi(node: &Node) -> FileNode {
    match node {
        Node::Dir { name, date, size, children } => FileNode {
            name: name.clone(),
            is_dir: true,
            size: *size,
            date: date.clone(),
            md5: None,
            sha1: None,
            sha256: None,
            unreadable: false,
            children: children.iter().map(node_to_ffi).collect(),
        },
        Node::File { name, date, size, md5, sha1, sha256, unreadable } => FileNode {
            name: name.clone(),
            is_dir: false,
            size: *size,
            date: date.clone(),
            md5: md5.clone(),
            sha1: sha1.clone(),
            sha256: sha256.clone(),
            unreadable: *unreadable,
            children: Vec::new(),
        },
    }
}

// ---- Progress + cancellation ----

/// Implemented on the Swift side; receives progress on a background thread.
#[uniffi::export(callback_interface)]
pub trait ProgressListener: Send + Sync {
    /// Batch-level: starting item `index` of `total`.
    fn on_batch(&self, index: u64, total: u64, name: String);
    /// A counter opened. `total == None` ⇒ indeterminate.
    fn on_counter_open(&self, id: u64, label: String, unit: String, total: Option<f64>);
    /// Counter advanced to `count`.
    fn on_progress(&self, id: u64, count: f64);
    /// Counter closed.
    fn on_counter_close(&self, id: u64);
    /// Free-text status line.
    fn on_message(&self, text: String);
}

/// A cooperative cancel flag. The UI keeps a handle and calls `cancel()`; the core
/// polls it between/within stages and unwinds with [`CuratorError::Cancelled`].
#[derive(uniffi::Object, Default)]
pub struct CancelHandle {
    flag: AtomicBool,
}

#[uniffi::export]
impl CancelHandle {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(CancelHandle::default())
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

/// Adapts a foreign [`ProgressListener`] + [`CancelHandle`] to the core's observer.
struct ListenerObserver {
    listener: Box<dyn ProgressListener>,
    cancel: Option<Arc<CancelHandle>>,
}

impl ProgressObserver for ListenerObserver {
    fn on_event(&self, ev: Event) {
        match ev {
            Event::BatchItem { index, total, name } => self.listener.on_batch(index, total, name),
            Event::CounterOpen { id, label, unit, total } => {
                self.listener.on_counter_open(id, label, unit, total)
            }
            Event::Progress { id, count } => self.listener.on_progress(id, count),
            Event::CounterClose { id } => self.listener.on_counter_close(id),
            Event::Message(text) => self.listener.on_message(text),
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.as_ref().is_some_and(|c| c.is_cancelled())
    }
}

// ---- Engine ----

/// The analysis engine. Construct once; methods are thread-safe.
#[derive(uniffi::Object)]
pub struct Engine {
    // The analyzer holds a single rusqlite connection (Send, !Sync); a Mutex makes the
    // engine shareable. Analyses serialize through it, which is fine for a desktop app.
    inner: Mutex<Analyzer>,
    // Lock-free read side (own DB connection + record cache) so the browser can query
    // and open builds while an import holds `inner` (WAL makes the reads concurrent).
    reader: Mutex<curator_core::Reader>,
}

#[uniffi::export]
impl Engine {
    /// Build an engine. Supply *either* `adapter_bin` (a bundled launcher; preferred
    /// in a shipped app) *or* `adapter_dir` (a uv project, for development). `data_dir`
    /// overrides the platform cache/library location.
    #[uniffi::constructor]
    pub fn new(
        adapter_dir: Option<String>,
        adapter_bin: Option<String>,
        data_dir: Option<String>,
    ) -> Result<Arc<Self>, CuratorError> {
        let adapter = match adapter_bin {
            Some(bin) => AdapterCommand::bin(&bin),
            None => AdapterCommand::uv(adapter_dir.as_deref().unwrap_or("ps2exe-adapter")),
        };
        let inner = Analyzer::new(Config { adapter, data_dir: data_dir.map(PathBuf::from) })?;
        let reader = inner.open_reader()?;
        Ok(Arc::new(Engine { inner: Mutex::new(inner), reader: Mutex::new(reader) }))
    }

    /// Analyze one image/container/folder. Served from cache when the sha256 is known.
    /// Progress flows to `listener`; trip `cancel` to abort.
    pub fn analyze(
        &self,
        path: String,
        listener: Box<dyn ProgressListener>,
        cancel: Option<Arc<CancelHandle>>,
    ) -> Result<AnalysisSummary, CuratorError> {
        let observer = Arc::new(ListenerObserver { listener, cancel });
        let analyzer = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let analysis = analyzer.analyze(&path, observer)?;
        build_summary(&analysis, |sha| analyzer.asset_blob_path(sha))
    }

    /// Number of builds in the local library.
    pub fn library_size(&self) -> Result<u64, CuratorError> {
        Ok(self.inner.lock().unwrap_or_else(|e| e.into_inner()).library_size()?)
    }

    /// The most recently analyzed builds, newest first.
    pub fn recent_builds(&self, limit: u32) -> Result<Vec<LibraryEntry>, CuratorError> {
        let rows = self.reader.lock().unwrap_or_else(|e| e.into_inner()).list_recent(limit)?;
        Ok(rows.into_iter().map(entry_from_row).collect())
    }

    /// Search/browse the library: `search` matches name or system, `system` filters
    /// to one, sorted by `sort` (descending when `descending`), paged by limit/offset.
    pub fn search_library(
        &self,
        search: Option<String>,
        system: Option<String>,
        sort: LibrarySort,
        descending: bool,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<LibraryEntry>, CuratorError> {
        // Reads go through the dedicated reader connection so the browser stays
        // responsive while an import holds the writer.
        let rows = self.reader.lock().unwrap_or_else(|e| e.into_inner()).search_builds(
            search.as_deref(),
            system.as_deref(),
            sort.into(),
            descending,
            limit,
            offset,
        )?;
        Ok(rows.into_iter().map(entry_from_row).collect())
    }

    /// Distinct systems in the library (for the browser's filter control).
    pub fn library_systems(&self) -> Result<Vec<String>, CuratorError> {
        Ok(self.reader.lock().unwrap_or_else(|e| e.into_inner()).list_systems()?)
    }

    /// Recursively list every file under `root`, sorted. Used by folder import:
    /// the UI walks the tree, then calls `analyze` on each and skips non-discs.
    pub fn list_files(&self, root: String) -> Result<Vec<String>, CuratorError> {
        Ok(curator_core::list_importable_files(std::path::Path::new(&root))
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect())
    }

    /// Reload a stored build from cache by sha256 (no adapter run). `None` if absent.
    /// Uses the reader, so it works while an import holds the writer.
    pub fn load_build(&self, sha256: String) -> Result<Option<AnalysisSummary>, CuratorError> {
        let reader = self.reader.lock().unwrap_or_else(|e| e.into_inner());
        match reader.load_cached(&sha256)? {
            Some(analysis) => Ok(Some(build_summary(&analysis, |sha| reader.asset_blob_path(sha))?)),
            None => Ok(None),
        }
    }

    /// Export the library as JSON Lines to `out_path` (the desktop→web feed). Returns
    /// the number of records written.
    pub fn export_jsonl(&self, out_path: String) -> Result<u64, CuratorError> {
        let file = std::fs::File::create(&out_path)
            .map_err(|e| CuratorError::Failed { message: format!("creating {out_path}: {e}") })?;
        Ok(self.inner.lock().unwrap_or_else(|e| e.into_inner()).export_jsonl(std::io::BufWriter::new(file))?)
    }

    /// Export the library as a portable `.zip` bundle (`manifest.json` +
    /// `builds.jsonl`) to `out_path` — the format to copy between machines and
    /// ingest into the web service. Returns the number of records written.
    pub fn export_bundle(&self, out_path: String) -> Result<u64, CuratorError> {
        Ok(self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .export_bundle(std::path::Path::new(&out_path))?)
    }
}
