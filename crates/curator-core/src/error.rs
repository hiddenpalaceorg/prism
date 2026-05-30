use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("adapter failed: {0}")]
    Adapter(String),

    #[error("unsupported or unreadable image: {0}")]
    Unsupported(String),

    #[error("{0}")]
    Other(String),
}
