//! Render a [`BuildRecord`] to the XML DAT (Redump/No-Intro `<datafile>` style) and JSON.

use std::fmt::Write as _;

use crate::error::Result;
use crate::schema::*;

/// Pretty-printed canonical JSON.
pub fn to_json(record: &BuildRecord) -> Result<String> {
    Ok(serde_json::to_string_pretty(record)?)
}

/// XML DAT document.
pub fn to_dat_xml(record: &BuildRecord) -> String {
    let mut s = String::new();
    s.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    s.push_str("<datafile>\n");

    // <image ...>
    let img = &record.image;
    let mut attrs = vec![
        ("name", img.name.clone()),
        ("size", img.size.to_string()),
        ("md5", img.md5.clone()),
        ("sha1", img.sha1.clone()),
        ("sha256", img.sha256.clone()),
    ];
    if let Some(ch) = &record.composites.content_hash {
        attrs.push(("content_hash", ch.clone()));
    }
    if let Some(fch) = &record.composites.filtered_content_hash {
        attrs.push(("filtered_content_hash", fch.clone()));
    }
    write_open(&mut s, 1, "image", &attrs);

    // <info>
    write_open(&mut s, 2, "info", &[]);
    let info = &record.info;
    let mut sys = vec![("name", info.system.clone())];
    if let Some(id) = &info.system_identifier {
        sys.push(("identifier", id.clone()));
    }
    write_empty(&mut s, 3, "system", &sys);

    let h = &info.header;
    let header_attrs = opt_attrs(&[
        ("title", &h.title),
        ("product_number", &h.product_number),
        ("product_version", &h.product_version),
        ("release_date", &h.release_date),
        ("maker_id", &h.maker_id),
        ("device_info", &h.device_info),
        ("regions", &h.regions),
    ]);
    if !header_attrs.is_empty() {
        write_empty(&mut s, 3, "header", &header_attrs);
    }

    let v = &info.volume;
    let vol_attrs = opt_attrs(&[
        ("identifier", &v.identifier),
        ("set_identifier", &v.set_identifier),
        ("creation_date", &v.creation_date),
        ("modification_date", &v.modification_date),
    ]);
    if !vol_attrs.is_empty() {
        write_empty(&mut s, 3, "volume", &vol_attrs);
    }

    if let Some(exe) = &info.exe {
        let mut ea = vec![("filename", exe.filename.clone())];
        if let Some(d) = &exe.date {
            ea.push(("date", d.clone()));
        }
        write_empty(&mut s, 3, "exe", &ea);
    }
    if let Some(dt) = &info.disc_type {
        write_empty(&mut s, 3, "disc", &[("type", dt.clone())]);
    }
    write_close(&mut s, 2, "info");

    // <contents>
    write_open(&mut s, 2, "contents", &[]);
    for node in &record.contents {
        write_node(&mut s, 3, node);
    }
    write_close(&mut s, 2, "contents");

    write_close(&mut s, 1, "image");

    write!(s, "  <version>curator {}</version>\n", env!("CARGO_PKG_VERSION")).ok();
    s.push_str("</datafile>\n");
    s
}

fn write_node(s: &mut String, indent: usize, node: &Node) {
    match node {
        Node::Dir { name, date, size, children } => {
            let mut a = vec![("name", name.clone())];
            if let Some(d) = date {
                a.push(("date", d.clone()));
            }
            if let Some(sz) = size {
                a.push(("size", sz.to_string()));
            }
            if children.is_empty() {
                write_empty(s, indent, "directory", &a);
            } else {
                write_open(s, indent, "directory", &a);
                for c in children {
                    write_node(s, indent + 1, c);
                }
                write_close(s, indent, "directory");
            }
        }
        Node::File { name, date, size, md5, sha1, sha256, unreadable } => {
            let mut a = vec![("name", name.clone())];
            if let Some(d) = date {
                a.push(("date", d.clone()));
            }
            if let Some(sz) = size {
                a.push(("size", sz.to_string()));
            }
            if let Some(x) = md5 {
                a.push(("md5", x.clone()));
            }
            if let Some(x) = sha1 {
                a.push(("sha1", x.clone()));
            }
            if let Some(x) = sha256 {
                a.push(("sha256", x.clone()));
            }
            if *unreadable {
                a.push(("unreadable", "true".into()));
            }
            write_empty(s, indent, "file", &a);
        }
    }
}

fn opt_attrs<'a>(pairs: &[(&'a str, &Option<String>)]) -> Vec<(&'a str, String)> {
    pairs
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|v| (*k, v.clone())))
        .collect()
}

fn indent(s: &mut String, level: usize) {
    for _ in 0..level {
        s.push_str("  ");
    }
}

fn write_attrs(s: &mut String, attrs: &[(&str, String)]) {
    for (k, v) in attrs {
        write!(s, " {}=\"{}\"", k, xml_escape(v)).ok();
    }
}

fn write_open(s: &mut String, level: usize, tag: &str, attrs: &[(&str, String)]) {
    indent(s, level);
    write!(s, "<{tag}").ok();
    write_attrs(s, attrs);
    s.push_str(">\n");
}

fn write_empty(s: &mut String, level: usize, tag: &str, attrs: &[(&str, String)]) {
    indent(s, level);
    write!(s, "<{tag}").ok();
    write_attrs(s, attrs);
    s.push_str(" />\n");
}

fn write_close(s: &mut String, level: usize, tag: &str) {
    indent(s, level);
    write!(s, "</{tag}>\n").ok();
}

fn xml_escape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for c in v.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}
