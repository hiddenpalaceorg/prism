//! Curator CLI — runs the core directly, output to stdout or a file.

mod progress;

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use curator_core::adapter::AdapterCommand;
use curator_core::schema::{FINGERPRINT_PROFILE, RECORD_SCHEMA_VERSION};
use curator_core::{render, Analyzer, Config};
use sha2::{Digest, Sha256};

use crate::progress::IndicatifObserver;

#[derive(Parser)]
#[command(name = "curator", version, about = "Analyze disc images into DAT/JSON and catalog them")]
struct Cli {
    /// Override the user data dir (cache + local catalog DB).
    #[arg(long, global = true)]
    data_dir: Option<PathBuf>,

    /// Directory of the uv-managed ps2exe-adapter project (development).
    #[arg(long, global = true, default_value = "ps2exe-adapter", env = "CURATOR_ADAPTER_DIR")]
    adapter_dir: String,

    /// Path to a bundled adapter launcher (shipped app; overrides --adapter-dir, no uv needed).
    #[arg(long, global = true, env = "CURATOR_ADAPTER_BIN")]
    adapter_bin: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Analyze one or more images/containers/folders.
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
    },
    /// Export the local catalog as the bulk web-contribute feed.
    ///
    /// With `--out FILE.zip`, writes a portable bundle (`manifest.json` +
    /// `builds.jsonl`) for copying to another machine and ingesting into the
    /// web service. Any other extension (or stdout) emits raw JSON Lines.
    Export {
        /// Write to this file instead of stdout. A `.zip` path produces a bundle.
        #[arg(long, short)]
        out: Option<PathBuf>,
    },
    /// Show local catalog stats.
    Stats,
}

#[derive(Copy, Clone, ValueEnum)]
enum Format {
    Xml,
    Json,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let adapter = match &cli.adapter_bin {
        Some(bin) => AdapterCommand::bin(bin),
        None => AdapterCommand::uv(&cli.adapter_dir),
    };
    let analyzer = Analyzer::new(Config { adapter, data_dir: cli.data_dir.clone() })
    .context("initializing analyzer")?;

    match cli.command {
        Command::Stats => {
            println!("builds in catalog: {}", analyzer.catalog_size()?);
        }
        Command::Export { out } => match &out {
            Some(p) if p.extension().and_then(|e| e.to_str()) == Some("zip") => {
                let n = write_zip_bundle(&analyzer, p)
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
        Command::Analyze { files, format, out } => {
            let total = files.len() as u64;
            for (i, path) in files.iter().enumerate() {
                let observer = Arc::new(IndicatifObserver::new());
                observer.batch(i as u64, total, path);

                let analysis = analyzer
                    .analyze(path, observer.clone())
                    .with_context(|| format!("analyzing {path}"))?;
                observer.finish();

                let rendered = match format {
                    Format::Xml => render::to_dat_xml(&analysis.record),
                    Format::Json => render::to_json(&analysis.record)?,
                };

                match &out {
                    Some(base) => {
                        let path = if total > 1 {
                            base.with_extension(format!("{i}.{}", ext(format)))
                        } else {
                            base.clone()
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
        }
    }

    Ok(())
}

fn ext(f: Format) -> &'static str {
    match f {
        Format::Xml => "xml",
        Format::Json => "json",
    }
}

/// Write a portable export bundle: a ZIP holding `builds.jsonl` (one canonical
/// record per line) and a `manifest.json` describing it. Double-clickable on
/// macOS/Windows; ingest the inner `builds.jsonl` on the other end.
fn write_zip_bundle(analyzer: &Analyzer, path: &Path) -> Result<u64> {
    use zip::write::SimpleFileOptions;

    let file = std::fs::File::create(path)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default();

    // Records first, hashing the exact bytes we store so the manifest can carry
    // an integrity digest the importer can verify.
    let n;
    let body_sha256 = {
        zip.start_file("builds.jsonl", opts)?;
        let mut hasher = Sha256::new();
        {
            let mut hw = HashingWriter { inner: &mut zip, hasher: &mut hasher };
            n = analyzer.export_jsonl(&mut hw)?;
        }
        hex::encode(hasher.finalize())
    };

    zip.start_file("manifest.json", opts)?;
    let manifest = serde_json::json!({
        "curator_bundle": 1,
        "record_schema_version": RECORD_SCHEMA_VERSION,
        "fingerprint_profile": FINGERPRINT_PROFILE,
        "count": n,
        "tool_version": env!("CARGO_PKG_VERSION"),
        "created_at": now_iso8601(),
        "body_sha256": body_sha256,
    });
    serde_json::to_writer_pretty(&mut zip, &manifest)?;

    zip.finish()?;
    Ok(n)
}

/// A `Write` that tees everything into a SHA-256 hasher on its way to `inner`.
struct HashingWriter<'a, W: Write> {
    inner: &'a mut W,
    hasher: &'a mut Sha256,
}

impl<W: Write> Write for HashingWriter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.hasher.update(&buf[..written]);
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Current UTC time as an ISO-8601 / RFC-3339 instant, e.g. `2026-06-01T12:34:56Z`.
fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
