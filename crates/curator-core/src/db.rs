//! Local SQLite catalog: the build index plus the similarity-check and submission
//! tables from PLAN.md. Identity is always `image.sha256`.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use crate::error::Result;
use crate::schema::BuildRecord;

pub struct Db {
    conn: Connection,
}

/// A catalog row for listing (recent builds, etc.).
#[derive(Debug, Clone)]
pub struct CatalogRow {
    pub sha256: String,
    pub name: String,
    pub system: String,
    pub file_count: u64,
    pub total_size: u64,
    pub analyzed_at: i64,
}

impl Db {
    pub fn open(data_dir: &Path) -> Result<Self> {
        let conn = Connection::open(data_dir.join("curator.db"))?;
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
    pub fn list_recent(&self, limit: u32) -> Result<Vec<CatalogRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT sha256, name, system, file_count, total_size, analyzed_at
             FROM builds ORDER BY analyzed_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |r| {
            Ok(CatalogRow {
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

    /// Cached JSON paths for every catalogued build, oldest first.
    pub fn list_json_paths(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT json_path FROM builds ORDER BY analyzed_at ASC")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
