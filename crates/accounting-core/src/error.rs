use std::fmt;

/// Errors surfaced to the UI. Database trigger messages are passed through
/// verbatim so that a rule enforced in SQL is reported with the same clarity as
/// one enforced in Rust.
#[derive(Debug)]
pub enum CoreError {
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    Json(serde_json::Error),
    /// Input that failed validation before it ever reached the database.
    Validation(String),
    /// A requested record does not exist.
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::Sqlite(err) => write!(f, "{err}"),
            CoreError::Io(err) => write!(f, "{err}"),
            CoreError::Json(err) => write!(f, "{err}"),
            CoreError::Validation(message) => write!(f, "{message}"),
            CoreError::NotFound(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for CoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            CoreError::Sqlite(err) => Some(err),
            CoreError::Io(err) => Some(err),
            CoreError::Json(err) => Some(err),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for CoreError {
    fn from(err: rusqlite::Error) -> Self {
        CoreError::Sqlite(err)
    }
}

impl From<std::io::Error> for CoreError {
    fn from(err: std::io::Error) -> Self {
        CoreError::Io(err)
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(err: serde_json::Error) -> Self {
        CoreError::Json(err)
    }
}

impl CoreError {
    pub fn validation(message: impl Into<String>) -> Self {
        CoreError::Validation(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        CoreError::NotFound(message.into())
    }
}
