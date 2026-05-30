//! Driver for the Python `ps2exe-adapter` subprocess.
//!
//! Contract: the adapter prints one canonical-raw JSON document on **stdout** and
//! streams NDJSON progress events on **stderr**. Rust never imports Python.

use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::Arc;

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::progress::{AdapterEvent, ProgressObserver};

/// How to invoke the adapter. Defaults to running it via uv from the workspace.
#[derive(Debug, Clone)]
pub struct AdapterCommand {
    pub program: String,
    /// Base args before the subcommand (e.g. `["run", "--project", "<dir>", "curator-adapter"]`).
    pub args: Vec<String>,
}

impl AdapterCommand {
    /// `uv run --project <adapter_dir> curator-adapter` (development).
    pub fn uv(adapter_dir: &str) -> Self {
        AdapterCommand {
            program: "uv".into(),
            args: vec![
                "run".into(),
                "--project".into(),
                adapter_dir.into(),
                "curator-adapter".into(),
            ],
        }
    }

    /// A bundled, self-contained adapter launcher (shipped app — no uv/Python needed).
    pub fn bin(launcher_path: &str) -> Self {
        AdapterCommand { program: launcher_path.into(), args: vec![] }
    }
}

// ---- Raw adapter output (normalized into the canonical schema by `normalize`) ----

#[derive(Debug, Deserialize)]
pub struct RawAnalysis {
    #[serde(default)]
    pub info: RawInfo,
    #[serde(default)]
    pub files: Vec<RawFile>,
    #[serde(default)]
    pub media: Vec<RawMedia>,
    #[serde(default)]
    pub exe_fp: Option<RawExeFp>,
}

#[derive(Debug, Deserialize)]
pub struct RawExeFp {
    pub tlsh: Option<String>,
    pub imphash: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RawMedia {
    pub path: String,
    pub kind: String,
    /// Acoustic sub-fingerprint set (Tier-4 audio); values < 2^53 so JSON-number safe.
    #[serde(default)]
    pub audio_fp: Vec<u64>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RawInfo {
    #[serde(default)]
    pub system: String,
    #[serde(default)]
    pub system_identifier: Option<String>,
    #[serde(default)]
    pub header: RawHeader,
    #[serde(default)]
    pub volume: RawVolume,
    #[serde(default)]
    pub exe: Option<RawExe>,
    #[serde(default)]
    pub disc_type: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RawHeader {
    pub title: Option<String>,
    pub product_number: Option<String>,
    pub product_version: Option<String>,
    pub release_date: Option<String>,
    pub maker_id: Option<String>,
    pub device_info: Option<String>,
    pub regions: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RawVolume {
    pub identifier: Option<String>,
    pub set_identifier: Option<String>,
    pub creation_date: Option<String>,
    pub modification_date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RawExe {
    pub filename: String,
    pub date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RawFile {
    /// Full path from the volume root, e.g. `/DATA/0.BIN`.
    pub path: String,
    #[serde(default)]
    pub is_dir: bool,
    pub date: Option<String>,
    pub size: Option<u64>,
    pub md5: Option<String>,
    pub sha1: Option<String>,
    pub sha256: Option<String>,
    #[serde(default)]
    pub unreadable: bool,
    /// FastCDC content-defined chunks as `[blake3_63bit, length]` (Tier-3). Absent for
    /// directories and files too large to buffer.
    #[serde(default)]
    pub chunks: Vec<(u64, u32)>,
}

/// Run the adapter on `path`, relaying progress to `observer`, and return its raw output.
pub fn run(
    cmd: &AdapterCommand,
    path: &str,
    observer: Arc<dyn ProgressObserver>,
) -> Result<RawAnalysis> {
    let mut child = Command::new(&cmd.program)
        .args(&cmd.args)
        .arg("analyze")
        .arg("--path")
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::Adapter(format!("failed to launch `{}`: {e}", cmd.program)))?;

    // Drain stderr (progress NDJSON) on a side thread so stdout can stream.
    let stderr = child.stderr.take().expect("piped stderr");
    let obs = observer.clone();
    let stderr_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut tail = String::new();
        for line in reader.lines().map_while(std::result::Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<AdapterEvent>(trimmed) {
                Ok(ev) => {
                    if let Some(ev) = ev.into_event() {
                        obs.on_event(ev);
                    }
                }
                // Non-JSON stderr is diagnostic output; keep the last lines for errors.
                Err(_) => {
                    tail.push_str(trimmed);
                    tail.push('\n');
                    if tail.len() > 8192 {
                        let cut = tail.len() - 8192;
                        tail.drain(..cut);
                    }
                }
            }
        }
        tail
    });

    // Read stdout on a side thread too, so the main thread can poll for cancellation
    // and kill the child promptly (analyses can run for minutes on multi-GB images).
    let mut stdout = child.stdout.take().expect("piped stdout");
    let stdout_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });

    let mut cancelled = false;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if observer.is_cancelled() {
            cancelled = true;
            let _ = child.kill();
            break child.wait()?;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };

    let stdout_buf = stdout_thread.join().unwrap_or_default();
    let diag = stderr_thread.join().unwrap_or_default();

    if cancelled {
        return Err(Error::Cancelled);
    }

    if !status.success() {
        return Err(Error::Adapter(format!(
            "adapter exited with {status}\n{}",
            diag.trim()
        )));
    }

    let parsed: RawAnalysis = serde_json::from_str(stdout_buf.trim()).map_err(|e| {
        Error::Adapter(format!("could not parse adapter output: {e}\nstderr:\n{}", diag.trim()))
    })?;
    Ok(parsed)
}
