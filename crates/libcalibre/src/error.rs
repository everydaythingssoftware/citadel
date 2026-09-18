use std::{fmt, path::PathBuf};

use crate::types::{AuthorId, BookId};

#[derive(Debug, thiserror::Error)]
pub enum CalibreError {
    #[error("Database error: {0}")]
    Database(String),

    #[error("Database integrity error: {0}")]
    DatabaseIntegrity(String),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    /// Book with given ID was not found.
    #[error("Book not found: {0}")]
    BookNotFound(BookId),

    /// Author with given ID was not found.
    #[error("Author not found: {0}")]
    AuthorNotFound(AuthorId),

    /// Book file with given ID was not found.
    #[error("Book file not found for book {0} with format {1}")]
    BookFileNotFound(BookId, String),

    /// The book exists, but it has no cover entry.
    #[error("Cover not found for book {0}")]
    BookCoverNotFound(BookId),

    /// The database points at an asset which is absent from disk.
    #[error("Asset file is missing: {0}")]
    AssetFileMissing(PathBuf),

    /// The database-resolved asset escapes the canonical library root.
    #[error("Asset path is outside the library root")]
    AssetOutsideLibrary,

    /// A format identifier is empty or contains path syntax.
    #[error("Invalid book format: {0}")]
    InvalidBookFormat(String),

    #[error("Author cannot be deleted; they have associated books")]
    AuthorHasAssociatedBooks(Vec<BookId>),

    /// Custom column with given ID was not found.
    #[error("Custom column not found: {0}")]
    CustomColumnNotFound(i32),

    /// Operation is not supported for the custom column's datatype
    /// (e.g. reading/writing series, rating, or composite columns).
    #[error("Unsupported custom column operation: {0}")]
    UnsupportedCustomColumn(String),

    /// Custom column definition is invalid (e.g. bad label, is_multiple on a
    /// non-text column).
    #[error("Invalid custom column: {0}")]
    InvalidCustomColumn(String),

    /// Custom column value is invalid (type mismatch, value not in an
    /// enumeration's allowed values, or an unparseable stored value).
    #[error("Invalid custom column value: {0}")]
    InvalidCustomValue(String),

    #[error("Library not initialized")]
    LibraryNotInitialized,

    #[error("Not implemented")]
    NotImplemented,

    #[error("Filesystem error: {0}")]
    FileSystem(String),

    /// Error indicating that a banned function was called, or a legal function
    /// was called with illegal parameters.
    ///
    /// Functions or function parameter values may be banned for security,
    /// stability, performance, or other reasons. Any time a ban error is
    /// returned, a reason is provideed.
    #[error("Banned function invocation")]
    BannedFunctionInvocation(String),

    #[error("Unknown error: {0}")]
    Unknown(String),
}

impl CalibreError {
    /// Helper to create a database error from any error type
    pub fn database<E: fmt::Display>(error: E) -> Self {
        CalibreError::Database(error.to_string())
    }

    /// Helper to create an unknown error from any error type
    pub fn unknown<E: fmt::Display>(error: E) -> Self {
        CalibreError::Unknown(error.to_string())
    }
}

// Allow converting from Box<dyn std::error::Error> for gradual migration
impl From<Box<dyn std::error::Error>> for CalibreError {
    fn from(error: Box<dyn std::error::Error>) -> Self {
        CalibreError::Unknown(error.to_string())
    }
}

impl From<diesel::result::Error> for CalibreError {
    fn from(error: diesel::result::Error) -> Self {
        CalibreError::Database(error.to_string())
    }
}
