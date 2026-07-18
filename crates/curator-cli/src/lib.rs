//! Curator CLI, as a library — one command surface exposed both by the
//! standalone `curator` binary and by the GUI executables' `--cli` mode, so the
//! two stay in lockstep. Covers everything the GUIs do: analyze/import, browse
//! the local library, inspect a build's views, extract assets, and talk to the
//! web service (Find Similar / Submit).

mod progress;
mod service;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use curator_core::adapter::AdapterCommand;
use curator_core::db::{LibraryRow, LibrarySort};
use curator_core::summary::{self, Section};
use curator_core::{render, Analysis, Analyzer, Config, Node, Reader};

use crate::progress::IndicatifObserver;

#[derive(Parser)]
#[command(name = "curator", version, about = "Analyze disc images into DAT/JSON and add them to a local library")]
struct Cli {
    /// Override the user data dir (cache + local library DB).
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,

    /// Directory of the uv-managed ps2exe-adapter project (development).
    #[arg(long, global = true, env = "CURATOR_ADAPTER_DIR")]
    adapter_dir: Option<String>,

    /// Path to a bundled adapter launcher (shipped app; overrides --adapter-dir, no uv needed).
    #[arg(long, global = true, env = "CURATOR_ADAPTER_BIN")]
    adapter_bin: Option<String>,

    /// Web service base URL (Find Similar / Submit).
    #[arg(long, global = true, env = "CURATOR_WEB_URL", default_value = "https://hiddenpalace.org")]
    web_url: String,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Analyze one or more images/containers/folders (a folder is one build).
    Analyze {
        /// Files to process.
        #[arg(required = true)]
        files: Vec<String>,
        /// Output format.
        #[arg(long, short, value_enum, default_value_t = Format::Xml)]
        format: Format,
        /// Write to this file instead of stdout (per-file: appends `.<n>` for multiple).
        #[arg(long, short)]
        out: Option<PathBuf>,
        /// Ignore the cached record: full re-parse and re-hash, replacing the
        /// stored record and library row.
        #[arg(long)]
        force: bool,
    },
    /// Recursively import folders into the library, skipping unsupported files.
    Import {
        /// Files or folders to import (folders expand to their import units).
        #[arg(required = true)]
        paths: Vec<String>,
    },
    /// Browse the local library (search, filter, sort).
    List {
        /// Substring to match against build names/systems.
        query: Option<String>,
        /// Only builds for this system.
        #[arg(long)]
        system: Option<String>,
        /// Sort column.
        #[arg(long, value_enum, default_value_t = SortKey::Date)]
        sort: SortKey,
        /// Sort ascending (default: descending for date/files/size, ascending for name/system).
        #[arg(long, conflicts_with = "desc")]
        asc: bool,
        /// Sort descending.
        #[arg(long)]
        desc: bool,
        /// Maximum rows to print.
        #[arg(long, default_value_t = 10_000)]
        limit: u32,
    },
    /// List the distinct systems in the library.
    Systems,
    /// The most recently analyzed builds, newest first.
    Recent {
        /// Maximum rows to print.
        #[arg(long, default_value_t = 15)]
        limit: u32,
    },
    /// Show a stored build from the library (no re-analysis).
    Show {
        /// sha256 of the build (a unique prefix works).
        sha: String,
        /// Which view to print.
        #[arg(long, value_enum, default_value_t = View::Overview)]
        view: View,
    },
    /// Extract a stored build's asset blobs to disk under their original paths.
    Extract {
        /// sha256 of the build (a unique prefix works).
        sha: String,
        /// Destination directory.
        #[arg(long, short, default_value = ".")]
        out: PathBuf,
        /// Only assets whose path contains this substring (case-insensitive).
        #[arg(long)]
        filter: Option<String>,
    },
    /// Query the web service for builds similar to a stored build or image file.
    Similar {
        /// sha256 (or unique prefix) of a stored build, or a path to analyze.
        target: String,
    },
    /// Analyze (if needed) and submit builds to the web service in one step,
    /// uploading any asset blobs it lacks.
    Submit {
        /// sha256s (or unique prefixes) of stored builds, or paths to analyze.
        #[arg(required = true)]
        targets: Vec<String>,
        /// Nickname for attribution.
        #[arg(long)]
        nickname: String,
        /// Expand folder targets into their import units, like `import`,
        /// instead of treating each folder as one build.
        #[arg(long, short = 'r')]
        recursive: bool,
        /// Re-analyze path targets from scratch before submitting, replacing
        /// the stored record (ignored for sha targets — no source image).
        #[arg(long)]
        force: bool,
        /// Moderation secret; when set, the submission is auto-accepted so it
        /// replaces the live build instead of waiting in the queue.
        #[arg(long, env = "CURATOR_MODERATION_TOKEN", hide_env_values = true)]
        moderation_token: Option<String>,
    },
    /// Export the local library as the bulk web-contribute feed.
    ///
    /// With `--out FILE.zip`, writes a portable bundle (`manifest.json` +
    /// `builds.jsonl`) for copying to another machine and ingesting into the
    /// web service. Any other extension (or stdout) emits raw JSON Lines.
    Export {
        /// Write to this file instead of stdout. A `.zip` path produces a bundle.
        #[arg(long, short)]
        out: Option<PathBuf>,
    },
    /// Show local library stats.
    Stats,
}

#[derive(Copy, Clone, ValueEnum)]
enum Format {
    Xml,
    Json,
}

#[derive(Copy, Clone, ValueEnum)]
enum SortKey {
    Name,
    System,
    Files,
    Size,
    Date,
}

#[derive(Copy, Clone, ValueEnum)]
enum View {
    Overview,
    Assets,
    Tree,
    Xml,
    Json,
}

/// Run the CLI over `args` (argv[0] included). `fallback_adapter` is the
/// host's adapter resolution (a GUI's bundled/embedded adapter), used when
/// neither `--adapter-bin` nor `--adapter-dir` (or their env vars) is given;
/// the standalone binary passes `None` and falls back to the dev uv project.
pub fn run(args: Vec<String>, fallback_adapter: Option<AdapterCommand>) -> i32 {
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(e) => {
            let _ = e.print();
            return e.exit_code();
        }
    };
    match execute(cli, fallback_adapter) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("error: {e:#}");
            1
        }
    }
}

fn execute(cli: Cli, fallback_adapter: Option<AdapterCommand>) -> Result<()> {
    let adapter = if let Some(bin) = &cli.adapter_bin {
        AdapterCommand::bin(bin)
    } else if let Some(dir) = &cli.adapter_dir {
        AdapterCommand::uv(dir)
    } else {
        fallback_adapter.unwrap_or_else(|| AdapterCommand::uv("ps2exe-adapter"))
    };
    let analyzer = Analyzer::new(Config { adapter, data_dir: cli.data_dir.clone() })
        .context("initializing analyzer")?;

    match cli.command {
        Command::Stats => {
            println!("builds in library: {}", analyzer.library_size()?);
        }
        Command::Export { out } => match &out {
            Some(p) if p.extension().and_then(|e| e.to_str()) == Some("zip") => {
                let n = analyzer
                    .export_bundle(p)
                    .with_context(|| format!("writing bundle {}", p.display()))?;
                eprintln!("exported {n} builds -> {}", p.display());
            }
            Some(p) => {
                let f = std::fs::File::create(p)
                    .with_context(|| format!("creating {}", p.display()))?;
                let n = analyzer.export_jsonl(std::io::BufWriter::new(f))?;
                eprintln!("exported {n} builds -> {}", p.display());
            }
            None => {
                let n = analyzer.export_jsonl(std::io::stdout().lock())?;
                eprintln!("exported {n} builds");
            }
        },
        Command::Analyze { files, format, out, force } => {
            analyze(&analyzer, &files, format, out.as_deref(), force)?;
        }
        Command::Import { paths } => {
            import(&analyzer, &paths)?;
        }
        Command::List { query, system, sort, asc, desc, limit } => {
            let sort = match sort {
                SortKey::Name => LibrarySort::Name,
                SortKey::System => LibrarySort::System,
                SortKey::Files => LibrarySort::Files,
                SortKey::Size => LibrarySort::Size,
                SortKey::Date => LibrarySort::Date,
            };
            // Same default direction as the GUI browser: newest/biggest first,
            // names and systems alphabetical.
            let desc = if asc {
                false
            } else if desc {
                true
            } else {
                !matches!(sort, LibrarySort::Name | LibrarySort::System)
            };
            let rows = analyzer.open_reader()?.search_builds(
                query.as_deref().filter(|q| !q.trim().is_empty()),
                system.as_deref(),
                sort,
                desc,
                limit,
                0,
            )?;
            print_rows(&rows);
        }
        Command::Systems => {
            for s in analyzer.open_reader()?.list_systems()? {
                println!("{s}");
            }
        }
        Command::Recent { limit } => {
            print_rows(&analyzer.open_reader()?.list_recent(limit)?);
        }
        Command::Show { sha, view } => {
            let reader = analyzer.open_reader()?;
            let analysis = load_build(&reader, &sha)?;
            match view {
                View::Overview => print_sections(&summary::overview_sections(&analysis.record)),
                View::Assets => {
                    let assets = analysis.record.assets.clone().unwrap_or_default();
                    let is_local = |sha: &str| reader.asset_blob_path(sha).is_some();
                    let (sections, _) =
                        summary::asset_sections(&assets, analysis.record.assets.is_some(), &is_local);
                    print_sections(&sections);
                }
                View::Tree => print_tree(&analysis.record.contents, 0),
                View::Xml => print!("{}", render::to_dat_xml(&analysis.record)),
                View::Json => print!("{}", render::to_json(&analysis.record)?),
            }
        }
        Command::Extract { sha, out, filter } => {
            extract(&analyzer, &sha, &out, filter.as_deref())?;
        }
        Command::Similar { target } => {
            let analysis = resolve_target(&analyzer, &target, false)?;
            let json = render::to_json(&analysis.record)?;
            let client = service::Client::new(&cli.web_url)?;
            eprintln!("querying similar builds…");
            print!("{}", client.similarity(&json)?);
        }
        Command::Submit { targets, nickname, recursive, force, moderation_token } => {
            if nickname.trim().is_empty() {
                bail!("--nickname must not be empty");
            }
            // With -r, folders expand to their import units; sha targets and
            // plain files pass through either way.
            let targets: Vec<String> = if recursive {
                targets
                    .iter()
                    .flat_map(|t| {
                        let p = Path::new(t);
                        if p.is_dir() {
                            curator_core::list_import_units(p)
                                .into_iter()
                                .map(|f| f.to_string_lossy().into_owned())
                                .collect()
                        } else {
                            vec![t.clone()]
                        }
                    })
                    .collect()
            } else {
                targets
            };
            if targets.is_empty() {
                bail!("nothing to submit");
            }
            let client = service::Client::new(&cli.web_url)?;
            let reader = analyzer.open_reader()?;
            let token = moderation_token.as_deref().filter(|t| !t.is_empty());
            let total = targets.len();
            let mut failed = 0usize;
            for (i, target) in targets.iter().enumerate() {
                if total > 1 {
                    eprintln!("[{}/{total}] {target}", i + 1);
                }
                if let Err(e) = submit_one(&analyzer, &reader, &client, target, &nickname, token, force)
                {
                    failed += 1;
                    eprintln!("error: {target}: {e:#}");
                }
            }
            if failed > 0 {
                bail!("{failed} of {total} submissions failed");
            }
        }
    }

    Ok(())
}

fn analyze(
    analyzer: &Analyzer,
    files: &[String],
    format: Format,
    out: Option<&Path>,
    force: bool,
) -> Result<()> {
    let total = files.len() as u64;
    for (i, path) in files.iter().enumerate() {
        let observer = Arc::new(IndicatifObserver::new());
        observer.batch(i as u64, total, path);

        let analysis = if force {
            analyzer.reanalyze(path, observer.clone())
        } else {
            analyzer.analyze(path, observer.clone())
        }
        .with_context(|| format!("analyzing {path}"))?;
        observer.finish();

        let rendered = match format {
            Format::Xml => render::to_dat_xml(&analysis.record),
            Format::Json => render::to_json(&analysis.record)?,
        };

        match out {
            Some(base) => {
                let path = if total > 1 {
                    base.with_extension(format!("{i}.{}", ext(format)))
                } else {
                    base.to_path_buf()
                };
                std::fs::write(&path, rendered)
                    .with_context(|| format!("writing {}", path.display()))?;
                eprintln!(
                    "{} {} -> {}",
                    if analysis.from_cache { "[cached]" } else { "[analyzed]" },
                    analysis.record.image.sha256,
                    path.display()
                );
            }
            None => print!("{rendered}"),
        }
    }
    Ok(())
}

/// Expand paths to a flat list of import units: directories are walked
/// recursively, except that a folder holding one build split across files (a
/// multi-track dump) stays a single unit and analyzes as one build. Plain
/// files pass through. Order is deterministic.
fn expand_inputs(paths: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for p in paths {
        let path = Path::new(p);
        if path.is_dir() {
            for f in curator_core::list_import_units(path) {
                out.push(f.to_string_lossy().into_owned());
            }
        } else if path.is_file() {
            out.push(p.clone());
        }
    }
    out
}

/// Batch-import a flat list of files: analyze each, skipping any that don't
/// parse (unsupported/unreadable), like the GUIs' recursive folder import.
fn import(analyzer: &Analyzer, paths: &[String]) -> Result<()> {
    let files = expand_inputs(paths);
    if files.is_empty() {
        eprintln!("no files found to import");
        return Ok(());
    }
    let total = files.len() as u64;
    let (mut imported, mut skipped) = (0u64, 0u64);
    for (i, path) in files.iter().enumerate() {
        let observer = Arc::new(IndicatifObserver::new());
        observer.batch(i as u64, total, path);
        match analyzer.analyze(path, observer.clone()) {
            Ok(_) => imported += 1,
            Err(e) => {
                skipped += 1;
                eprintln!("  skipped {path}: {e}");
            }
        }
        observer.finish();
    }
    println!("imported {imported}, skipped {skipped} unsupported");
    Ok(())
}

/// Resolve a full sha256 or a unique library prefix to the full sha256.
fn resolve_sha(reader: &Reader, s: &str) -> Result<String> {
    let hex = s.chars().all(|c| c.is_ascii_hexdigit());
    if s.len() == 64 && hex {
        return Ok(s.to_ascii_lowercase());
    }
    if !hex || s.len() < 6 {
        bail!("{s} is not a sha256 or a prefix of at least 6 hex chars");
    }
    let needle = s.to_ascii_lowercase();
    let rows = reader.search_builds(None, None, LibrarySort::Date, true, u32::MAX, 0)?;
    let mut matches = rows.iter().filter(|r| r.sha256.starts_with(&needle));
    match (matches.next(), matches.next()) {
        (Some(row), None) => Ok(row.sha256.clone()),
        (Some(_), Some(_)) => bail!("more than one build matches {s}; use more characters"),
        (None, _) => bail!("no build in the library matches {s}"),
    }
}

/// Load a stored build from cache by sha256 (or unique prefix).
fn load_build(reader: &Reader, sha: &str) -> Result<Analysis> {
    let sha = resolve_sha(reader, sha)?;
    reader
        .load_cached(&sha)?
        .with_context(|| format!("build {sha} is not in the cache anymore"))
}

/// A submit/similar target: an existing path is analyzed (cache hit when
/// already imported; `force` re-parses from scratch); anything else is
/// treated as a library sha256/prefix.
fn resolve_target(analyzer: &Analyzer, target: &str, force: bool) -> Result<Analysis> {
    if Path::new(target).exists() {
        let observer = Arc::new(IndicatifObserver::new());
        let analysis = if force {
            analyzer.reanalyze(target, observer.clone())
        } else {
            analyzer.analyze(target, observer.clone())
        }
        .with_context(|| format!("analyzing {target}"))?;
        observer.finish();
        Ok(analysis)
    } else {
        load_build(&analyzer.open_reader()?, target)
    }
}

/// Analyze (or load) one submit target and push it to the web service.
fn submit_one(
    analyzer: &Analyzer,
    reader: &Reader,
    client: &service::Client,
    target: &str,
    nickname: &str,
    moderation_token: Option<&str>,
    force: bool,
) -> Result<()> {
    let analysis = resolve_target(analyzer, target, force)?;
    let json = render::to_json(&analysis.record)?;
    eprintln!(
        "{} {} — {}",
        if analysis.from_cache { "[cached]" } else { "[analyzed]" },
        analysis.record.image.sha256,
        analysis.record.info.system,
    );
    // Resolve which of the build's asset blobs exist locally (sha256 → path);
    // the client uploads whichever the server lacks.
    let mut local: HashMap<String, PathBuf> = HashMap::new();
    for a in analysis.record.assets.as_deref().unwrap_or_default() {
        if let Some(p) = reader.asset_blob_path(&a.sha256) {
            local.insert(a.sha256.clone(), p);
        }
    }
    client.submit(&analysis.record.image.sha256, &json, nickname, &local, moderation_token)
}

fn extract(analyzer: &Analyzer, sha: &str, out: &Path, filter: Option<&str>) -> Result<()> {
    let reader = analyzer.open_reader()?;
    let analysis = load_build(&reader, sha)?;
    let Some(assets) = &analysis.record.assets else {
        bail!("asset extraction hasn't run for this build — re-analyze the image");
    };
    let needle = filter.map(str::to_lowercase);
    let (mut extracted, mut missing) = (0u64, 0u64);
    for asset in assets {
        if let Some(n) = &needle {
            if !asset.path.to_lowercase().contains(n) {
                continue;
            }
        }
        let Some(blob) = reader.asset_blob_path(&asset.sha256) else {
            missing += 1;
            continue;
        };
        // Rebuild the asset's internal path under `out`, sanitizing each
        // component (record paths are untrusted: no traversal, no odd chars).
        let mut dest = out.to_path_buf();
        for comp in asset.path.split('/').filter(|c| !c.is_empty()) {
            dest.push(safe_component(comp));
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        std::fs::copy(&blob, &dest)
            .with_context(|| format!("writing {}", dest.display()))?;
        println!("{}", dest.display());
        extracted += 1;
    }
    let note = if missing > 0 {
        format!(", {missing} not in local store (re-analyze the image to extract them)")
    } else {
        String::new()
    };
    eprintln!("extracted {extracted} assets{note}");
    Ok(())
}

/// One path component, sanitized for the local filesystem: Windows-invalid and
/// control characters become `_`, and names that reduce to dots/spaces (".",
/// "..") are replaced outright.
fn safe_component(comp: &str) -> String {
    let safe: String = comp
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    if safe.trim_matches(['.', ' ']).is_empty() {
        "_".to_string()
    } else {
        safe
    }
}

fn print_sections(sections: &[Section]) {
    for (i, sec) in sections.iter().enumerate() {
        if i > 0 {
            println!();
        }
        println!("{}", sec.title);
        let width = sec.rows.iter().map(|(k, _)| k.chars().count()).max().unwrap_or(0);
        for (key, value) in &sec.rows {
            println!("  {key:<width$}  {value}");
        }
    }
}

fn print_tree(nodes: &[Node], depth: usize) {
    for node in nodes {
        let indent = "  ".repeat(depth);
        match node {
            Node::Dir { name, children, .. } => {
                println!("{indent}{name}/");
                print_tree(children, depth + 1);
            }
            Node::File { name, size, unreadable, .. } => {
                let mut line = format!("{indent}{name}");
                if let Some(sz) = size {
                    line.push_str(&format!("  ({})", summary::human_size(*sz)));
                }
                if *unreadable {
                    line.push_str("  [unreadable]");
                }
                println!("{line}");
            }
        }
    }
}

fn print_rows(rows: &[LibraryRow]) {
    if rows.is_empty() {
        eprintln!("(no builds)");
        return;
    }
    let name_w = rows.iter().map(|r| r.name.chars().count()).max().unwrap_or(0).clamp(4, 60);
    let sys_w = rows.iter().map(|r| r.system.chars().count()).max().unwrap_or(0).max(6);
    println!(
        "{:<name_w$}  {:<sys_w$}  {:>6}  {:>9}  {:<10}  {}",
        "NAME", "SYSTEM", "FILES", "SIZE", "ANALYZED", "SHA256"
    );
    for r in rows {
        println!(
            "{:<name_w$}  {:<sys_w$}  {:>6}  {:>9}  {:<10}  {}",
            truncate(&r.name, name_w),
            r.system,
            r.file_count,
            summary::human_size(r.total_size),
            summary::fmt_unix_date(r.analyzed_at),
            r.sha256,
        );
    }
}

/// Truncate to `max` chars with a trailing ellipsis.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn ext(f: Format) -> &'static str {
    match f {
        Format::Xml => "xml",
        Format::Json => "json",
    }
}
