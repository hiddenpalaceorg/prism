//! Local SQLite library: the build index plus the similarity-check and submission
//! tables from PLAN.md. Identity is always `image.sha256`.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use crate::error::Result;
use crate::schema::BuildRecord;

pub struct Db {
    conn: Connection,
}

/// A library row for listing (recent builds, browse, etc.).
#[derive(Debug, Clone)]
pub struct LibraryRow {
    pub sha256: String,
    pub name: String,
    pub system: String,
    pub file_count: u64,
    pub total_size: u64,
    pub analyzed_at: i64,
}

/// Column the library browser sorts on. Maps to a fixed SQL column name (never
/// interpolate caller text into ORDER BY).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LibrarySort {
    Name,
    System,
    Files,
    Size,
    Date,
}

impl LibrarySort {
    fn column(self) -> &'static str {
        match self {
            LibrarySort::Name => "name",
            LibrarySort::System => "system",
            LibrarySort::Files => "file_count",
            LibrarySort::Size => "total_size",
            LibrarySort::Date => "analyzed_at",
        }
    }
}

impl Db {
    pub fn open(data_dir: &Path) -> Result<Self> {
        let conn = Connection::open(data_dir.join("curator.db"))?;
        // WAL lets a reader connection (the GUIs' library browser) query while the
        // writer (an in-progress import) commits, instead of serializing on one lock.
        // busy_timeout rides out the brief moments a writer holds the file.
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")?;
        let db = Db { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS builds (
                sha256                TEXT PRIMARY KEY,
                name                  TEXT NOT NULL,
                system                TEXT NOT NULL,
                size                  INTEGER NOT NULL,
                md5                   TEXT NOT NULL,
                sha1                  TEXT NOT NULL,
                content_hash          TEXT,
                filtered_content_hash TEXT,
                file_count            INTEGER NOT NULL,
                total_size            INTEGER NOT NULL,
                fingerprint_profile   TEXT NOT NULL,
                analyzed_at           INTEGER NOT NULL,
                json_path             TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_builds_content ON builds(content_hash);
            CREATE INDEX IF NOT EXISTS idx_builds_system  ON builds(system);

            -- contributor identity (single row)
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- cached similarity-check results, keyed by sha256
            CREATE TABLE IF NOT EXISTS similarity_check (
                sha256      TEXT PRIMARY KEY,
                checked_at  INTEGER NOT NULL,
                refreshed_at INTEGER,
                result_json TEXT NOT NULL
            );

            -- local submission outbox + synced server status
            CREATE TABLE IF NOT EXISTS submission (
                sha256      TEXT PRIMARY KEY,
                nickname    TEXT NOT NULL,
                status      TEXT NOT NULL,          -- queued|uploaded|accepted|rejected
                queued_at   INTEGER NOT NULL,
                uploaded_at INTEGER
            );
            "#,
        )?;
        Ok(())
    }

    pub fn upsert_build(&self, record: &BuildRecord, json_path: &str) -> Result<()> {
        let now = unix_now();
        self.conn.execute(
            r#"
            INSERT INTO builds
                (sha256, name, system, size, md5, sha1, content_hash, filtered_content_hash,
                 file_count, total_size, fingerprint_profile, analyzed_at, json_path)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
            ON CONFLICT(sha256) DO UPDATE SET
                name=excluded.name, system=excluded.system, size=excluded.size,
                md5=excluded.md5, sha1=excluded.sha1,
                content_hash=excluded.content_hash,
                filtered_content_hash=excluded.filtered_content_hash,
                file_count=excluded.file_count, total_size=excluded.total_size,
                fingerprint_profile=excluded.fingerprint_profile,
                analyzed_at=excluded.analyzed_at, json_path=excluded.json_path
            "#,
            params![
                record.image.sha256,
                record.image.name,
                record.info.system,
                record.image.size,
                record.image.md5,
                record.image.sha1,
                record.composites.content_hash.as_deref(),
                record.composites.filtered_content_hash.as_deref(),
                record.structural.file_count,
                record.structural.total_size,
                record.fingerprint_profile,
                now,
                json_path,
            ],
        )?;
        Ok(())
    }

    pub fn count_builds(&self) -> Result<u64> {
        let n: i64 = self.conn.query_row("SELECT COUNT(*) FROM builds", [], |r| r.get(0))?;
        Ok(n as u64)
    }

    /// The most recently analyzed builds, newest first.
    pub fn list_recent(&self, limit: u32) -> Result<Vec<LibraryRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT sha256, name, system, file_count, total_size, analyzed_at
             FROM builds ORDER BY analyzed_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |r| {
            Ok(LibraryRow {
                sha256: r.get(0)?,
                name: r.get(1)?,
                system: r.get(2)?,
                file_count: r.get::<_, i64>(3)? as u64,
                total_size: r.get::<_, i64>(4)? as u64,
                analyzed_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Search/browse the library. `search` matches name or system (case-insensitive
    /// substring); `system` filters to one system exactly. Results are sorted by
    /// `sort` (descending when `desc`), with a stable `name` tiebreak, then paged.
    pub fn search_builds(
        &self,
        search: Option<&str>,
        system: Option<&str>,
        sort: LibrarySort,
        desc: bool,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<LibraryRow>> {
        let mut sql = String::from(
            "SELECT sha256, name, system, file_count, total_size, analyzed_at FROM builds WHERE 1=1",
        );
        let mut args: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        if let Some(q) = search.filter(|s| !s.trim().is_empty()) {
            sql.push_str(" AND (name LIKE ?1 ESCAPE '\\' OR system LIKE ?1 ESCAPE '\\')");
            args.push(Box::new(format!("%{}%", like_escape(q))));
        }
        if let Some(sys) = system.filter(|s| !s.is_empty()) {
            let n = args.len() + 1;
            sql.push_str(&format!(" AND system = ?{n}"));
            args.push(Box::new(sys.to_string()));
        }
        // `sort.column()` is a fixed identifier, not caller text — safe to inline.
        let dir = if desc { "DESC" } else { "ASC" };
        sql.push_str(&format!(
            " ORDER BY {} {dir}, name COLLATE NOCASE ASC LIMIT ?{} OFFSET ?{}",
            sort.column(),
            args.len() + 1,
            args.len() + 2,
        ));
        args.push(Box::new(limit));
        args.push(Box::new(offset));

        let param_refs: Vec<&dyn rusqlite::types::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(param_refs.as_slice(), |r| {
            Ok(LibraryRow {
                sha256: r.get(0)?,
                name: r.get(1)?,
                system: r.get(2)?,
                file_count: r.get::<_, i64>(3)? as u64,
                total_size: r.get::<_, i64>(4)? as u64,
                analyzed_at: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Distinct systems present in the library, alphabetical — for the filter UI.
    pub fn list_systems(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT system FROM builds WHERE system <> '' ORDER BY system COLLATE NOCASE")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Cached JSON paths for every stored build, oldest first.
    pub fn list_json_paths(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT json_path FROM builds ORDER BY analyzed_at ASC")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::*;

    fn rec(sha: &str, name: &str, system: &str, files: u64, size: u64) -> BuildRecord {
        BuildRecord {
            record_schema_version: RECORD_SCHEMA_VERSION,
            fingerprint_profile: FINGERPRINT_PROFILE.into(),
            image: ImageInfo { name: name.into(), size, md5: "m".into(), sha1: "s".into(), sha256: sha.into() },
            info: DiscInfo { system: system.into(), ..Default::default() },
            composites: Composites::default(),
            structural: Structural {
                system: system.into(),
                file_count: files,
                total_size: size,
                max_depth: 1,
                ext_histogram: Default::default(),
            },
            text_doc: String::new(),
            contents: vec![],
            media: vec![],
            exe_fp: None,
            chunk_signature: None,
            resemblance: None,
            assets: None,
        }
    }

    fn names(rows: &[LibraryRow]) -> Vec<&str> {
        rows.iter().map(|r| r.name.as_str()).collect()
    }

    #[test]
    fn search_filter_sort_and_page() {
        let dir = std::env::temp_dir().join(format!("curator-db-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir).unwrap();
        db.upsert_build(&rec("h1", "Sonic CD (USA)", "Sega CD", 10, 1000), "p1").unwrap();
        db.upsert_build(&rec("h2", "Sonic CD (Europe)", "Sega CD", 20, 2000), "p2").unwrap();
        db.upsert_build(&rec("h3", "Crash Bandicoot", "PSX", 5, 500), "p3").unwrap();

        // Sort by name ascending — alphabetical across all rows.
        let all = db.search_builds(None, None, LibrarySort::Name, false, 100, 0).unwrap();
        assert_eq!(names(&all), ["Crash Bandicoot", "Sonic CD (Europe)", "Sonic CD (USA)"]);

        // Case-insensitive substring over the name.
        let sonic = db.search_builds(Some("sonic"), None, LibrarySort::Name, false, 100, 0).unwrap();
        assert_eq!(sonic.len(), 2);

        // Search also matches the system column.
        let psx = db.search_builds(Some("psx"), None, LibrarySort::Name, false, 100, 0).unwrap();
        assert_eq!(names(&psx), ["Crash Bandicoot"]);

        // Exact system filter.
        let segacd = db.search_builds(None, Some("Sega CD"), LibrarySort::Size, true, 100, 0).unwrap();
        assert_eq!(names(&segacd), ["Sonic CD (Europe)", "Sonic CD (USA)"]); // size desc: 2000, 1000

        // Paging by name ascending.
        let page0 = db.search_builds(None, None, LibrarySort::Name, false, 1, 0).unwrap();
        let page1 = db.search_builds(None, None, LibrarySort::Name, false, 1, 1).unwrap();
        assert_eq!(names(&page0), ["Crash Bandicoot"]);
        assert_eq!(names(&page1), ["Sonic CD (Europe)"]);

        // Wildcards in the term are matched literally (no rows contain '%').
        assert!(db.search_builds(Some("%"), None, LibrarySort::Name, false, 100, 0).unwrap().is_empty());

        assert_eq!(db.list_systems().unwrap(), ["PSX", "Sega CD"]);

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Escape LIKE wildcards so a user's search term matches literally (paired with
/// `ESCAPE '\'` in the query).
fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
