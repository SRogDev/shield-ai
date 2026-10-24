//! Shield AI CLI library.
//!
//! A thin local adapter for the Shield backend: device-flow login,
//! gitignore-aware file discovery with an in-memory snapshot, and a
//! resumable file-level upload. It contains no analysis logic — the
//! backend is the authority for identity, entitlement, and analysis.
//!
//! Command surface (exactly three commands, see `docs/PLAN_V2.md` §8):
//! `shield login`, `shield scan [path]` (`--auto` supported),
//! `shield logout`.

pub mod api;
pub mod auth;
pub mod cli;
pub mod files;

use std::fmt;

/// The crate-wide result type.
pub type Result<T> = std::result::Result<T, Error>;

/// A human-readable error. `retryable` marks transient failures
/// (network errors, 5xx responses) that bounded retry may recover from.
#[derive(Debug)]
pub struct Error {
    message: String,
    retryable: bool,
}

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Error {
            message: message.into(),
            retryable: false,
        }
    }

    pub fn retryable(message: impl Into<String>) -> Self {
        Error {
            message: message.into(),
            retryable: true,
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn is_retryable(&self) -> bool {
        self.retryable
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::new(format!("I/O error: {e}"))
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::new(format!("invalid JSON: {e}"))
    }
}
