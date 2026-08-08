//! Driver for the Python `ps2exe-adapter` subprocess.
//!
//! Contract: the adapter prints one canonical-raw JSON document on **stdout** and
//! streams NDJSON progress events on **stderr**. Rust never imports Python.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Deserializer};

use crate::error::{Error, Result};
use crate::progress::{AdapterEvent, ProgressObserver};

/// Kill an adapter that stops reporting progress. This is deliberately an
/// inactivity timeout rather than a limit on the whole operation: healthy
/// multi-disc analyses may take longer, while a native archive decoder can get
/// stuck forever on one malformed member.
const ADAPTER_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Deserialize a value that may be JSON `null` into `T::default()`. ps2exe emits
/// `null` (not "") for required strings it can't determine — notably `system` on
/// a file it doesn't recognize as a known disc. `#[serde(default)]` only covers a
/// *missing* key, so required `String` fields pair it with this for explicit null.
fn null_to_default<'de, D, T>(d: D) -> std::result::Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// How to invoke the adapter. Defaults to running it via uv from the workspace.
#[derive(Debug, Clone)]
pub struct AdapterCommand {
    pub program: String,
    /// Base args before the subcommand (e.g. `["run", "--project", "<dir>", "prism-adapter"]`).
    pub args: Vec<String>,
    /// Append verbose adapter lifecycle and stderr output here when enabled.
    pub debug_log: Option<PathBuf>,
}

impl AdapterCommand {
    /// `uv run --project <adapter_dir> prism-adapter` (development).
    pub fn uv(adapter_dir: &str) -> Self {
        AdapterCommand {
            program: "uv".into(),
            args: vec![
                "run".into(),
                "--project".into(),
                adapter_dir.into(),
                "prism-adapter".into(),
            ],
            debug_log: None,
        }
    }

    /// A bundled, self-contained adapter launcher (shipped app — no uv/Python needed).
    pub fn bin(launcher_path: &str) -> Self {
        AdapterCommand {
            program: launcher_path.into(),
            args: vec![],
            debug_log: None,
        }
    }

    /// Enable verbose Python logging and preserve the complete adapter trace.
    pub fn with_debug_log(mut self, path: impl Into<PathBuf>) -> Self {
        self.args.push("--debug".into());
        self.debug_log = Some(path.into());
        self
    }
}

fn debug_line(log: &Option<Arc<Mutex<std::fs::File>>>, message: impl std::fmt::Display) {
    if let Some(log) = log {
        if let Ok(mut file) = log.lock() {
            let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            let _ = writeln!(file, "{now} {message}");
            let _ = file.flush();
        }
    }
}

fn open_debug_log(path: &Path) -> Result<Arc<Mutex<std::fs::File>>> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    Ok(Arc::new(Mutex::new(file)))
}

/// Terminate the launcher and anything it spawned. Killing only `uv`/the shell
/// can leave the adapter alive with stdout/stderr pipes open, making the joins
/// below hang even after the timeout fired.
fn kill_adapter_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let pid = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(unix)]
    {
        let group = format!("-{}", child.id());
        let _ = Command::new("kill")
            .args(["-KILL", &group])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
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
    #[serde(default, deserialize_with = "null_to_default")]
    pub path: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub kind: String,
    /// Acoustic sub-fingerprint set (audio); values < 2^53 so JSON-number safe.
    #[serde(default)]
    pub audio_fp: Vec<u64>,
}

#[derive(Debug, Default, Deserialize)]
pub struct RawInfo {
    #[serde(default, deserialize_with = "null_to_default")]
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
    pub alt_exe: Option<RawAltExe>,
    #[serde(default)]
    pub sfo: Option<RawSfo>,
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
    pub expiration_date: Option<String>,
    pub effective_date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RawExe {
    pub filename: Option<String>,
    pub date: Option<String>,
    pub signing_type: Option<String>,
    pub num_symbols: Option<u64>,
}

/// Alternate/decrypted boot executable (PSP/PS3/Xbox).
#[derive(Debug, Deserialize)]
pub struct RawAltExe {
    pub filename: Option<String>,
    pub date: Option<String>,
    pub md5: Option<String>,
}

/// PARAM.SFO metadata (PSP/PS3).
#[derive(Debug, Deserialize)]
pub struct RawSfo {
    pub title: Option<String>,
    pub disc_id: Option<String>,
    pub disc_version: Option<String>,
    pub category: Option<String>,
    pub parental_level: Option<String>,
    pub system_version: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RawFile {
    /// Full path from the volume root, e.g. `/DATA/0.BIN`.
    #[serde(default, deserialize_with = "null_to_default")]
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
    /// True for a file listed from inside an archive member (`/DIR/A.ZIP/...`).
    /// Members appear in the contents tree, text corpus, and structural counts,
    /// but composites skip them — the archive stays one opaque file for
    /// identity. The adapter also never fingerprints them (no chunks/shingle).
    #[serde(default)]
    pub in_archive: bool,
    /// FastCDC content-defined chunks as [blake3_63bit, length]. Absent for
    /// directories.
    #[serde(default)]
    pub chunks: Vec<(u64, u32)>,
    /// One-Permutation-Hashing byte-shingle signature, length SHINGLE_K. Present
    /// only for large files; combined into the build-level resemblance signature.
    #[serde(default)]
    pub shingle: Vec<u64>,
}

/// One extracted browser-viewable asset (see the adapter's `extract` command).
#[derive(Debug, Deserialize)]
pub struct RawAsset {
    #[serde(default, deserialize_with = "null_to_default")]
    pub path: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default, deserialize_with = "null_to_default")]
    pub mime: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pub kind: String,
}

#[derive(Debug, Deserialize)]
struct RawExtract {
    #[serde(default)]
    assets: Vec<RawAsset>,
}

/// Run the adapter's `analyze` on `path`, relaying progress to `observer`.
pub fn run(
    cmd: &AdapterCommand,
    path: &str,
    observer: Arc<dyn ProgressObserver>,
) -> Result<RawAnalysis> {
    run_json(cmd, &["analyze", "--path", path], observer)
}

/// Run the adapter's `extract` on `path`, filling the content-addressed asset
/// store at `out_dir` and returning the extracted assets' metadata.
pub fn run_extract(
    cmd: &AdapterCommand,
    path: &str,
    out_dir: &str,
    observer: Arc<dyn ProgressObserver>,
) -> Result<Vec<RawAsset>> {
    let parsed: RawExtract = run_json(cmd, &["extract", "--path", path, "--out", out_dir], observer)?;
    Ok(parsed.assets)
}

/// Describe a failed adapter run. A native crash (libarchive aborts on input it
/// refuses) arrives as a 128+signal exit code once the launcher relays it, which
/// on its own reads as an opaque "exit status: 134".
fn describe_exit(status: std::process::ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        let signal = status.signal().or_else(|| match status.code() {
            Some(code) if (129..=192).contains(&code) => Some(code - 128),
            _ => None,
        });
        if let Some(sig) = signal {
            return match sig {
                2 => "crashed with SIGINT".into(),
                4 => "crashed with SIGILL".into(),
                6 => "crashed with SIGABRT (native abort)".into(),
                8 => "crashed with SIGFPE".into(),
                9 => "killed with SIGKILL (out of memory?)".into(),
                11 => "crashed with SIGSEGV (native fault)".into(),
                15 => "killed with SIGTERM".into(),
                other => format!("killed by signal {other}"),
            };
        }
    }
    format!("exited with {status}")
}

/// Drive one adapter subprocess: stream stderr progress to `observer`, poll for
/// cancellation, and parse the single JSON document on stdout as `T`.
fn run_json<T: serde::de::DeserializeOwned>(
    cmd: &AdapterCommand,
    args: &[&str],
    observer: Arc<dyn ProgressObserver>,
) -> Result<T> {
    run_json_with_timeout(cmd, args, observer, ADAPTER_INACTIVITY_TIMEOUT)
}

fn run_json_with_timeout<T: serde::de::DeserializeOwned>(
    cmd: &AdapterCommand,
    args: &[&str],
    observer: Arc<dyn ProgressObserver>,
    inactivity_timeout: Duration,
) -> Result<T> {
    let debug_log = cmd.debug_log.as_deref().map(open_debug_log).transpose()?;
    debug_line(
        &debug_log,
        format_args!("adapter start: {:?} {:?} {:?}", cmd.program, cmd.args, args),
    );
    let mut builder = Command::new(&cmd.program);
    builder
        .args(&cmd.args)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        builder.process_group(0);
    }
    // Windows: run the adapter without popping up a console window (it's a console exe;
    // stdout/stderr are still captured through the pipes above).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        builder.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = builder
        .spawn()
        .map_err(|e| Error::Adapter(format!("failed to launch `{}`: {e}", cmd.program)))?;
    debug_line(&debug_log, format_args!("adapter pid: {}", child.id()));

    // Drain stderr (progress NDJSON) on a side thread so stdout can stream.
    let stderr = child.stderr.take().expect("piped stderr");
    let obs = observer.clone();
    let last_progress = Arc::new(std::sync::Mutex::new(Instant::now()));
    let stderr_progress = last_progress.clone();
    let stderr_log = debug_log.clone();
    let stderr_thread = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut tail = String::new();
        for line in reader.lines().map_while(std::result::Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            debug_line(&stderr_log, format_args!("adapter stderr: {trimmed}"));
            match serde_json::from_str::<AdapterEvent>(trimmed) {
                Ok(ev) => {
                    if let Ok(mut last) = stderr_progress.lock() {
                        *last = Instant::now();
                    }
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
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if observer.is_cancelled() {
            cancelled = true;
            debug_line(&debug_log, "adapter cancellation requested");
            kill_adapter_tree(&mut child);
            break child.wait()?;
        }
        let inactive_for = last_progress
            .lock()
            .map(|last| last.elapsed())
            .unwrap_or_default();
        if inactive_for >= inactivity_timeout {
            timed_out = true;
            debug_line(
                &debug_log,
                format_args!(
                    "adapter timeout: {} seconds without progress",
                    inactivity_timeout.as_secs()
                ),
            );
            kill_adapter_tree(&mut child);
            break child.wait()?;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };

    let stdout_buf = stdout_thread.join().unwrap_or_default();
    let diag = stderr_thread.join().unwrap_or_default();
    debug_line(
        &debug_log,
        format_args!(
            "adapter finish: status={} stdout_bytes={} diagnostic_bytes={}",
            describe_exit(status),
            stdout_buf.len(),
            diag.len()
        ),
    );

    if cancelled {
        return Err(Error::Cancelled);
    }

    if timed_out {
        return Err(Error::Adapter(format!(
            "adapter timed out after {} seconds without progress\n{}",
            inactivity_timeout.as_secs(),
            diag.trim()
        )));
    }

    if !status.success() {
        return Err(Error::Adapter(format!(
            "adapter {}\n{}",
            describe_exit(status),
            diag.trim()
        )));
    }

    let parsed: T = serde_json::from_str(stdout_buf.trim()).map_err(|e| {
        Error::Adapter(format!("could not parse adapter output: {e}\nstderr:\n{}", diag.trim()))
    })?;
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::progress::NoopObserver;

    #[test]
    fn adapter_is_killed_after_inactivity_timeout() {
        #[cfg(windows)]
        let cmd = AdapterCommand {
            program: "powershell.exe".into(),
            args: vec![
                "-NoProfile".into(),
                "-Command".into(),
                "Start-Sleep -Seconds 10".into(),
            ],
            debug_log: None,
        };
        #[cfg(unix)]
        let cmd = AdapterCommand {
            program: "sh".into(),
            args: vec!["-c".into(), "sleep 10".into()],
            debug_log: None,
        };

        let started = Instant::now();
        let result = run_json_with_timeout::<serde_json::Value>(
            &cmd,
            &[],
            Arc::new(NoopObserver),
            Duration::from_millis(100),
        );

        assert!(matches!(result, Err(Error::Adapter(ref msg)) if msg.contains("timed out")));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
