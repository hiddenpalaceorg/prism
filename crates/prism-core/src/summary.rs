//! Human-readable presentation of a [`BuildRecord`] — the formatted overview,
//! per-file metadata, and asset listing shared by the GUIs and the CLI, so every
//! front-end shows the same fields in the same order.

use crate::schema::{AssetRef, BuildRecord, Node};

/// A titled group of key/value rows — one section of a formatted view.
#[derive(Clone, Debug)]
pub struct Section {
    pub title: String,
    pub rows: Vec<(String, String)>,
}

/// Display order + section titles for asset kinds — mirrors the web build pages.
pub const ASSET_KINDS: [(&str, &str); 7] = [
    ("image", "Images"),
    ("audio", "Audio"),
    ("video", "Video"),
    ("document", "Documents"),
    ("source", "Source code"),
    ("text", "Text"),
    ("binary", "Unidentified"),
];

pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut i = 0;
    while value >= 1024.0 && i < UNITS.len() - 1 {
        value /= 1024.0;
        i += 1;
    }
    format!("{value:.1} {}", UNITS[i])
}

/// Unix seconds → `YYYY-MM-DD` (UTC). Empty when out of range.
pub fn fmt_unix_date(secs: i64) -> String {
    chrono::DateTime::from_timestamp(secs, 0)
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// `19970414` → `1997-04-14`; anything else is returned unchanged.
pub fn pretty_date(s: &str) -> String {
    if s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit()) {
        format!("{}-{}-{}", &s[0..4], &s[4..6], &s[6..8])
    } else {
        s.to_string()
    }
}

/// Build a section if it has any rows (keeps empty groups out of the view).
fn section(title: &str, rows: Vec<(String, String)>) -> Option<Section> {
    if rows.is_empty() {
        None
    } else {
        Some(Section { title: title.to_string(), rows })
    }
}

/// Collect non-empty `(key, value)` rows; `opt` skips absent fields.
struct Rows(Vec<(String, String)>);
impl Rows {
    fn new() -> Self {
        Rows(Vec::new())
    }
    fn add(&mut self, k: &str, v: impl Into<String>) {
        let v = v.into();
        if !v.is_empty() {
            self.0.push((k.to_string(), v));
        }
    }
    fn opt(&mut self, k: &str, v: &Option<String>) {
        if let Some(v) = v {
            self.add(k, v.clone());
        }
    }
}

/// Formatted build metadata — the readable counterpart to the raw DAT/XML.
pub fn overview_sections(record: &BuildRecord) -> Vec<Section> {
    let mut out = Vec::new();

    let img = &record.image;
    let mut r = Rows::new();
    r.add("Name", img.name.clone());
    r.add("Size", human_size(img.size));
    r.add("MD5", img.md5.clone());
    r.add("SHA-1", img.sha1.clone());
    r.add("SHA-256", img.sha256.clone());
    out.extend(section("Image", r.0));

    let info = &record.info;
    let mut r = Rows::new();
    r.add("System", info.system.clone());
    r.opt("System ID", &info.system_identifier);
    r.opt("Disc type", &info.disc_type);
    out.extend(section("Disc", r.0));

    let h = &info.header;
    if !h.is_empty() {
        let mut r = Rows::new();
        r.opt("Title", &h.title);
        r.opt("Product No.", &h.product_number);
        r.opt("Version", &h.product_version);
        r.add("Release date", h.release_date.as_deref().map(pretty_date).unwrap_or_default());
        r.opt("Maker", &h.maker_id);
        r.opt("Device", &h.device_info);
        r.opt("Regions", &h.regions);
        out.extend(section("Header", r.0));
    }

    if let Some(s) = &info.sfo {
        let mut r = Rows::new();
        r.opt("Title", &s.title);
        r.opt("Disc ID", &s.disc_id);
        r.opt("Disc version", &s.disc_version);
        r.opt("Category", &s.category);
        r.opt("Parental level", &s.parental_level);
        r.opt("System version", &s.system_version);
        out.extend(section("SFO", r.0));
    }

    let vol = &info.volume;
    if !vol.is_empty() {
        let mut r = Rows::new();
        r.opt("Identifier", &vol.identifier);
        r.opt("Set identifier", &vol.set_identifier);
        r.opt("Created", &vol.creation_date);
        r.opt("Modified", &vol.modification_date);
        r.opt("Expires", &vol.expiration_date);
        r.opt("Effective", &vol.effective_date);
        out.extend(section("Volume", r.0));
    }

    if let Some(e) = &info.exe {
        let mut r = Rows::new();
        r.opt("Filename", &e.filename);
        r.opt("Date", &e.date);
        r.opt("Signing", &e.signing_type);
        if let Some(n) = e.num_symbols {
            r.add("Symbols", n.to_string());
        }
        out.extend(section("Boot executable", r.0));
    }

    if let Some(a) = &info.alt_exe {
        let mut r = Rows::new();
        r.opt("Filename", &a.filename);
        r.opt("Date", &a.date);
        r.opt("Decrypted MD5", &a.md5);
        out.extend(section("Alternate executable", r.0));
    }

    let c = &record.composites;
    let mut r = Rows::new();
    r.opt("Content hash", &c.content_hash);
    r.opt("Filtered hash", &c.filtered_content_hash);
    r.opt("Boot exe hash", &c.hash_exe);
    if let Some(m) = &c.most_recent_file {
        r.add("Most recent", m.path.clone());
    }
    if c.incomplete_files > 0 {
        r.add("Incomplete", c.incomplete_files.to_string());
    }
    out.extend(section("Content", r.0));

    let st = &record.structural;
    let mut r = Rows::new();
    r.add("Files", st.file_count.to_string());
    r.add("Total size", human_size(st.total_size));
    out.extend(section("Structure", r.0));

    out
}

/// Per-file metadata shown when a single tree node / path is selected.
pub fn node_section(node: &Node) -> Section {
    let mut rows: Vec<(String, String)> = Vec::new();
    let mut row = |k: &str, v: &str| {
        if !v.is_empty() {
            rows.push((k.to_string(), v.to_string()));
        }
    };
    let title = match node {
        Node::Dir { name, date, size, md5, sha1, sha256, children } => {
            row("Name", name);
            if let Some(d) = date {
                row("Date", d);
            }
            if let Some(sz) = size {
                row("Size", &human_size(*sz));
            }
            row("Items", &children.len().to_string());
            // An archive listed as a directory: show the file's own hashes.
            if let Some(h) = md5 {
                row("MD5", h);
            }
            if let Some(h) = sha1 {
                row("SHA-1", h);
            }
            if let Some(h) = sha256 {
                row("SHA-256", h);
            }
            if sha1.is_some() || sha256.is_some() || md5.is_some() {
                "Archive"
            } else {
                "Directory"
            }
        }
        Node::File { name, date, size, md5, sha1, sha256, unreadable } => {
            row("Name", name);
            if let Some(sz) = size {
                row("Size", &human_size(*sz));
            }
            if let Some(d) = date {
                row("Date", d);
            }
            if *unreadable {
                row("Status", "Unreadable (bad dump)");
            }
            if let Some(h) = md5 {
                row("MD5", h);
            }
            if let Some(h) = sha1 {
                row("SHA-1", h);
            }
            if let Some(h) = sha256 {
                row("SHA-256", h);
            }
            "File"
        }
    };
    Section { title: title.to_string(), rows }
}

/// The asset listing, grouped by kind in [`ASSET_KINDS`] order. Returns the
/// sections plus a flat row → `assets` index map (rows flatten kind groups),
/// which click-to-open UIs need. `extracted` distinguishes "extraction ran,
/// nothing viewable" from "extraction never ran"; `is_local` reports whether a
/// blob sha256 is present in the local asset store.
pub fn asset_sections(
    assets: &[AssetRef],
    extracted: bool,
    is_local: &dyn Fn(&str) -> bool,
) -> (Vec<Section>, Vec<usize>) {
    let mut sections = Vec::new();
    let mut rows_map = Vec::new();
    if assets.is_empty() {
        sections.push(Section {
            title: "Assets".into(),
            rows: vec![(
                "Status".into(),
                if extracted {
                    "No extractable assets in this build.".into()
                } else {
                    "Asset extraction hasn't run for this build — re-analyze the image.".into()
                },
            )],
        });
    }
    for (kind, title) in ASSET_KINDS {
        let idxs: Vec<usize> = assets
            .iter()
            .enumerate()
            .filter(|(_, a)| a.kind == kind)
            .map(|(i, _)| i)
            .collect();
        if idxs.is_empty() {
            continue;
        }
        let rows = idxs
            .iter()
            .map(|&i| {
                let a = &assets[i];
                let name = a.path.rsplit('/').next().unwrap_or(&a.path).to_string();
                let mut detail = format!("{} — {} — {}", a.path, human_size(a.size), a.mime);
                if !is_local(&a.sha256) {
                    detail.push_str(" — not in local store");
                }
                (name, detail)
            })
            .collect();
        sections.push(Section { title: format!("{title} ({})", idxs.len()), rows });
        rows_map.extend(idxs);
    }
    (sections, rows_map)
}

/// Render the web service's `/api/similarity` JSON response as a readable
/// neighbor list (`\n` line endings; convert for CRLF displays).
pub fn format_similarity(body: &str) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return format!("Unexpected response:\n{body}");
    };
    let sections = [
        ("Identical content", "identical_content"),
        ("Shared files", "shared_files"),
        ("Similar chunks", "similar_chunks"),
        ("Same boot imports", "exe_imports"),
        ("Similar executable", "exe_similar"),
        ("Shared audio tracks", "audio_neighbors"),
        ("Semantically related (text)", "text_neighbors"),
    ];
    let mut out = String::from("Similar builds\n==============\n");
    let mut any = false;
    for (title, key) in sections {
        let Some(arr) = v.get(key).and_then(|x| x.as_array()) else { continue };
        if arr.is_empty() {
            continue;
        }
        any = true;
        out.push_str(&format!("\n{title}\n"));
        for item in arr {
            let name = item.get("name").and_then(|x| x.as_str()).unwrap_or("?");
            let sha = item.get("sha256").and_then(|x| x.as_str()).unwrap_or("");
            let score = item
                .get("jaccard")
                .and_then(|x| x.as_f64())
                .map(|j| format!("  {:.0}%", j * 100.0))
                .or_else(|| item.get("distance").and_then(|x| x.as_f64()).map(|d| format!("  d={d}")))
                .or_else(|| item.get("cosine").and_then(|x| x.as_f64()).map(|c| format!("  {c:.2}")))
                .unwrap_or_default();
            out.push_str(&format!("  {name}  [{}…]{score}\n", &sha.chars().take(12).collect::<String>()));
        }
    }
    if !any {
        out.push_str("\nNo similar builds found.\n");
    }
    out
}
