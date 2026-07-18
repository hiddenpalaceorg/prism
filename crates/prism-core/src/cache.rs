//! sha256-keyed on-disk cache of analyzed builds, in the user data dir.
//! Re-analyzing a known image is skipped: read its `<sha256>.json` instead.

use std::path::{Path, PathBuf};

use directories::ProjectDirs;

use crate::error::{Error, Result};
use crate::schema::BuildRecord;

pub struct Cache {
    dir: PathBuf,
}

impl Cache {
    /// Cache rooted at the platform user-data dir, or an explicit override.
    pub fn open(override_dir: Option<&Path>) -> Result<Self> {
        let base = match override_dir {
            Some(p) => p.to_path_buf(),
            None => default_data_dir()?,
        };
        let dir = base.join("cache");
        std::fs::create_dir_all(&dir)?;
        Ok(Cache { dir })
    }

    pub fn json_path(&self, sha256: &str) -> PathBuf {
        self.dir.join(format!("{sha256}.json"))
    }

    pub fn xml_path(&self, sha256: &str) -> PathBuf {
        self.dir.join(format!("{sha256}.xml"))
    }

    pub fn chunks_path(&self, sha256: &str) -> PathBuf {
        self.dir.join(format!("{sha256}.chunks"))
    }

    /// Write the binary chunk sidecar. Skipped when empty (no file was chunked).
    pub fn store_chunks(&self, sha256: &str, sidecar: &[u8]) -> Result<()> {
        if sidecar.len() > 8 {
            std::fs::write(self.chunks_path(sha256), sidecar)?;
        }
        Ok(())
    }

    pub fn load(&self, sha256: &str) -> Result<Option<BuildRecord>> {
        validate_sha256(sha256)?;
        let p = self.json_path(sha256);
        if !p.exists() {
            return Ok(None);
        }
        let bytes = std::fs::read(&p)?;
        Ok(Some(serde_json::from_slice(&bytes)?))
    }

    /// Write `<sha256>.json` and `<sha256>.xml`. Returns the JSON path.
    pub fn store(&self, record: &BuildRecord, xml: &str) -> Result<PathBuf> {
        let json = serde_json::to_vec_pretty(record)?;
        let jp = self.json_path(&record.image.sha256);
        std::fs::write(&jp, json)?;
        std::fs::write(self.xml_path(&record.image.sha256), xml)?;
        Ok(jp)
    }
}

/// Reject any caller-supplied key that isn't a bare 64-char lowercase hex sha256,
/// preventing `../` path traversal when the key is interpolated into a filename.
fn validate_sha256(sha256: &str) -> Result<()> {
    if sha256.len() == 64 && sha256.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        Ok(())
    } else {
        Err(Error::Other(format!("invalid sha256 key: {sha256:?}")))
    }
}

pub fn default_data_dir() -> Result<PathBuf> {
    let pd = ProjectDirs::from("org", "HiddenPalace", "prism")
        .ok_or_else(|| Error::Other("could not resolve a user data directory".into()))?;
    let dir = pd.data_dir().to_path_buf();
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}
