//! Curator CLI — runs the core directly, output to stdout or a file.

mod progress;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use curator_core::adapter::AdapterCommand;
use curator_core::{render, Analyzer, Config};

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
    /// Export the local catalog as JSON Lines (the bulk web-contribute feed).
    Export {
        /// Write to this file instead of stdout.
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
        Command::Export { out } => {
            let n = match &out {
                Some(p) => {
                    let f = std::fs::File::create(p)
                        .with_context(|| format!("creating {}", p.display()))?;
                    let n = analyzer.export_jsonl(std::io::BufWriter::new(f))?;
                    eprintln!("exported {n} builds -> {}", p.display());
                    n
                }
                None => analyzer.export_jsonl(std::io::stdout().lock())?,
            };
            let _ = n;
        }
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
