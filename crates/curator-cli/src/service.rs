//! Web-service client: Find Similar and Submit (with resumable asset-blob
//! uploads). The protocol mirrors the GUIs' native HTTP implementations — a
//! submission POST, a missing-blob check, chunked PUTs that resume on 409 and
//! back off on 429, and an optional moderated accept.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};

/// Upload chunk size — small enough to clear typical proxy body-size limits.
const UPLOAD_CHUNK: usize = 4 * 1024 * 1024;

/// How many asset blobs to upload at once.
const PARALLEL_UPLOADS: usize = 32;

/// Give up after this many consecutive rate-limit waits on one chunk.
const MAX_THROTTLE_RETRIES: u32 = 30;

pub struct Client {
    agent: ureq::Agent,
    base: String,
}

impl Client {
    pub fn new(web_url: &str) -> Result<Self> {
        let tls = native_tls::TlsConnector::new().context("initializing TLS")?;
        let agent = ureq::AgentBuilder::new()
            .tls_connector(Arc::new(tls))
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(60))
            .timeout_write(Duration::from_secs(60))
            .build();
        Ok(Client { agent, base: web_url.trim_end_matches('/').to_string() })
    }

    /// Send a request; any HTTP status is returned as `(code, body)` — only
    /// transport failures error.
    fn request(
        &self,
        verb: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<(u16, String)> {
        let mut req = self.agent.request(verb, url);
        for (k, v) in headers {
            req = req.set(k, v);
        }
        let resp = match body {
            Some(b) => req.send_bytes(b),
            None => req.call(),
        };
        match resp {
            Ok(r) => Ok((r.status(), r.into_string().unwrap_or_default())),
            Err(ureq::Error::Status(code, r)) => Ok((code, r.into_string().unwrap_or_default())),
            Err(e) => bail!("cannot reach service: {e}"),
        }
    }

    /// POST the record to `/api/similarity` and format the neighbor list.
    pub fn similarity(&self, record_json: &str) -> Result<String> {
        let url = format!("{}/api/similarity", self.base);
        let (code, body) = self.request(
            "POST",
            &url,
            &[("Content-Type", "application/json")],
            Some(record_json.as_bytes()),
        )?;
        if !(200..300).contains(&code) {
            bail!("server error {code}: {}", body.trim());
        }
        Ok(curator_core::summary::format_similarity(&body))
    }

    /// Submit a build record, upload whichever of its asset blobs the server
    /// lacks (from `local`: sha256 → blob path), and — with a moderation
    /// token — accept the submission so it replaces the live build.
    pub fn submit(
        &self,
        build_sha: &str,
        record_json: &str,
        nickname: &str,
        local: &HashMap<String, PathBuf>,
        moderation_token: Option<&str>,
    ) -> Result<()> {
        let record: serde_json::Value =
            serde_json::from_str(record_json).context("parsing record JSON")?;
        let body = serde_json::json!({ "nickname": nickname, "record": record });
        let url = format!("{}/api/submissions", self.base);
        let (code, b) = self.request(
            "POST",
            &url,
            &[("Content-Type", "application/json")],
            Some(body.to_string().as_bytes()),
        )?;
        if !(200..300).contains(&code) {
            bail!("server error {code}: {}", b.trim());
        }
        let status = serde_json::from_str::<serde_json::Value>(&b)
            .ok()
            .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(String::from))
            .unwrap_or_else(|| "queued".into());
        println!("submitted — {status}");

        self.upload_missing_assets(build_sha, local)?;

        if let Some(token) = moderation_token {
            self.accept(build_sha, token)?;
        }
        Ok(())
    }

    /// Ask the server which of the submitted build's asset blobs it lacks,
    /// then PUT each one we hold locally, a few at once. Errors if any upload
    /// fails — the record submission itself has already succeeded by then.
    fn upload_missing_assets(&self, build_sha: &str, local: &HashMap<String, PathBuf>) -> Result<()> {
        if local.is_empty() {
            return Ok(()); // nothing extracted locally — nothing to offer
        }
        let assets_url = format!("{}/api/submissions/{build_sha}/assets", self.base);
        let (code, body) = self.request("GET", &assets_url, &[], None)?;
        if !(200..300).contains(&code) {
            bail!("asset check failed: server error {code} (submission is queued)");
        }
        let missing: Vec<String> = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| {
                v.get("missing").and_then(|m| m.as_array()).map(|arr| {
                    arr.iter().filter_map(|s| s.as_str().map(String::from)).collect()
                })
            })
            .unwrap_or_default();
        if missing.is_empty() {
            println!("assets already on server");
            return Ok(());
        }
        let todo: Vec<&String> = missing.iter().filter(|sha| local.contains_key(*sha)).collect();
        let unavailable = missing.len() - todo.len();
        if todo.is_empty() {
            println!("{unavailable} missing asset blobs are not in the local store");
            return Ok(());
        }
        // Workers pull the next blob off a shared counter; each blob is its own
        // resumable PUT (chunks of one blob never interleave).
        let total = todo.len();
        let next = AtomicUsize::new(0);
        let completed = AtomicUsize::new(0);
        let ok_count = AtomicUsize::new(0);
        std::thread::scope(|s| {
            for _ in 0..PARALLEL_UPLOADS.min(total) {
                s.spawn(|| loop {
                    let Some(sha) = todo.get(next.fetch_add(1, Ordering::Relaxed)) else { break };
                    let ok = self.upload_asset_chunked(&assets_url, sha, &local[*sha]);
                    if ok {
                        ok_count.fetch_add(1, Ordering::Relaxed);
                    }
                    let n = completed.fetch_add(1, Ordering::Relaxed) + 1;
                    eprintln!(
                        "  [{n}/{total}] {}… {}",
                        &sha[..12.min(sha.len())],
                        if ok { "uploaded" } else { "FAILED" }
                    );
                });
            }
        });
        let uploaded = ok_count.into_inner();
        let failed = total - uploaded;
        let mut note = format!("uploaded {uploaded} asset blob{}", if uploaded == 1 { "" } else { "s" });
        if unavailable > 0 {
            note.push_str(&format!(", {unavailable} not in local store"));
        }
        println!("{note}");
        if failed > 0 {
            bail!("{failed} asset upload{} failed (submission is queued; retry to resume)",
                if failed == 1 { "" } else { "s" });
        }
        Ok(())
    }

    /// PUT one asset blob in resumable chunks: each request appends at
    /// `offset`, a 409 answers with the server's staged offset to resume from,
    /// and the final chunk returns `stored` (or `exists`).
    fn upload_asset_chunked(&self, assets_url: &str, sha: &str, path: &Path) -> bool {
        let Ok(bytes) = std::fs::read(path) else { return false };
        let mut offset: usize = 0;
        let mut last_staged: Option<usize> = None;
        let mut throttled = 0u32;
        while offset < bytes.len() {
            let end = (offset + UPLOAD_CHUNK).min(bytes.len());
            let url = format!("{assets_url}/{sha}?offset={offset}");
            let chunk = &bytes[offset..end];
            let Ok((code, body)) = self.request(
                "PUT",
                &url,
                &[("Content-Type", "application/octet-stream")],
                Some(chunk),
            ) else {
                return false;
            };
            match code {
                c if (200..300).contains(&c) => {
                    let v = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
                    match v.get("status").and_then(|s| s.as_str()) {
                        Some("stored") | Some("exists") => return true,
                        _ => {
                            offset = v
                                .get("offset")
                                .and_then(|o| o.as_u64())
                                .map(|o| o as usize)
                                .unwrap_or(end);
                            last_staged = None;
                            throttled = 0;
                        }
                    }
                }
                429 => {
                    // Rate limited — wait out the window (the server's
                    // retryAfter when present) and retry the same offset.
                    throttled += 1;
                    if throttled > MAX_THROTTLE_RETRIES {
                        return false;
                    }
                    let secs = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| v.get("retryAfter").and_then(|r| r.as_f64()))
                        .unwrap_or(5.0)
                        .clamp(1.0, 120.0);
                    std::thread::sleep(Duration::from_secs_f64(secs));
                }
                409 => {
                    // Resume where the server actually is; the same answer
                    // twice means we're not making progress — give up.
                    let staged = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| v.get("offset").and_then(|o| o.as_u64()))
                        .map(|o| o as usize)
                        .unwrap_or(0);
                    if last_staged == Some(staged) {
                        return false;
                    }
                    last_staged = Some(staged);
                    offset = staged;
                }
                _ => return false,
            }
        }
        false // ran out of local bytes without the server confirming the store
    }

    /// Accept the just-submitted build with the moderation token, so the
    /// record (and its refreshed assets) replaces the live build immediately.
    fn accept(&self, build_sha: &str, token: &str) -> Result<()> {
        let url = format!("{}/api/submissions/{build_sha}", self.base);
        let (code, body) = self.request(
            "POST",
            &url,
            &[("Content-Type", "application/json"), ("x-moderation-token", token)],
            Some(br#"{"action":"accept"}"#),
        )?;
        match code {
            c if (200..300).contains(&c) => {
                println!("accepted — live build updated");
                Ok(())
            }
            401 => bail!("accept failed: moderation token rejected (submission stays queued)"),
            c => bail!("accept failed: server error {c}: {} (submission stays queued)", body.trim()),
        }
    }
}
