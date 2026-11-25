use std::{fmt, path::PathBuf};

use crate::types::{AuthorId, BookId};

/// Everything that can go wrong in libcalibre.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum CalibreError {
    /// SQLite failed: the database couldn't be opened, a query failed, or a
    /// constraint was violated. Writes through a handle from
    /// [`Library::open_read_only`](crate::Library::open_read_only) fail this
    /// way too.
    #[error("Database error: {0}")]
    Database(String),

    /// The library isn't shaped as a Calibre library must be: `metadata.db`
    /// has no schema version or no `library_id` row, or a book's folder path
    /// is unsafe to delete in
    /// [`Library::delete_books`](crate::Library::delete_books).
    #[error("Database integrity error: {0}")]
    DatabaseIntegrity(String),

    /// A filesystem call failed while resolving or validating paths in the
    /// library, creating a library folder, or writing an upgrade backup.
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    /// The search text of a book query does not parse, is over a limit, or
    /// uses a feature that is not supported. The span is the byte range of
    /// the text that causes the error.
    #[error("{0}")]
    InvalidSearch(crate::Spanned<crate::SearchError>),

    /// Book with given ID was not found.
    #[error("Book not found: {0}")]
    BookNotFound(BookId),

    /// Author with given ID was not found.
    #[error("Author not found: {0}")]
    AuthorNotFound(AuthorId),

    /// The book has no file in the requested format.
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

    /// A format identifier is empty, or contains something other than ASCII
    /// letters and digits once a leading `.` is removed.
    #[error("Invalid book format: {0}")]
    InvalidBookFormat(String),

    /// [`Library::remove_author`](crate::Library::remove_author) was asked to
    /// delete an author still linked to these books.
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

    /// Read state was written on a library opened without a read column.
    #[error("This library has no read column")]
    NoReadColumn,

    /// Custom column value is invalid (type mismatch, value not in an
    /// enumeration's allowed values, or an unparseable stored value).
    #[error("Invalid custom column value: {0}")]
    InvalidCustomValue(String),

    /// Ratings run from 0 (unrated) to 10 (five stars).
    #[error("Invalid rating {0}: ratings run from 0 to 10")]
    InvalidRating(i32),

    /// Not currently returned by libcalibre.
    #[error("Library not initialized")]
    LibraryNotInitialized,

    /// The database's Calibre schema is older than this build opens.
    #[error("This library's database is schema version {version}, older than Citadel supports ({minimum}); open it in Calibre once to upgrade it")]
    UnsupportedSchema {
        /// The database's schema version.
        version: i32,
        /// The oldest version this build opens,
        /// [`MINIMUM_SCHEMA_VERSION`](crate::MINIMUM_SCHEMA_VERSION).
        minimum: i32,
    },

    /// The folder already holds a `metadata.db`.
    #[error("A Calibre library already exists at {0}")]
    LibraryAlreadyExists(PathBuf),

    /// The folder has no `metadata.db`.
    #[error("Not a Calibre library (no metadata.db): {0}")]
    NotALibrary(PathBuf),

    /// libcalibre stores paths as UTF-8 and can't open this one.
    #[error("Path is not valid UTF-8: {0}")]
    NonUtf8Path(PathBuf),

    /// [`Library::upgrade`](crate::Library::upgrade) was called on a handle
    /// opened read-only. Other writes through such a handle fail with
    /// [`CalibreError::Database`].
    #[error("The library is open read-only")]
    ReadOnlyLibrary,

    /// Not currently returned by libcalibre.
    #[error("Not implemented")]
    NotImplemented,

    /// A file couldn't be read, written or copied, or a book's folder
    /// couldn't be made: adding a book, reading a book file or cover,
    /// writing a cover. Also returned by
    /// [`Library::create_library_at`](crate::Library::create_library_at) for
    /// a path that isn't valid UTF-8.
    #[error("Filesystem error: {0}")]
    FileSystem(String),

    /// Error indicating that a banned function was called, or a legal function
    /// was called with illegal parameters.
    ///
    /// Functions or function parameter values may be banned for security,
    /// stability, performance, or other reasons. Any time a ban error is
    /// returned, a reason is provided.
    #[error("Banned function invocation")]
    BannedFunctionInvocation(String),

    /// Another error's message, made by [`CalibreError::unknown`] or converted
    /// from a `Box<dyn Error>`. libcalibre's own operations don't return it.
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

#[doc(hidden)]
impl From<diesel::result::Error> for CalibreError {
    fn from(error: diesel::result::Error) -> Self {
        CalibreError::Database(error.to_string())
    }
}
