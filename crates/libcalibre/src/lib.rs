mod assets;
pub mod book_file;
mod create;
mod custom_columns;
mod entities;
pub mod error;
pub mod library;
pub mod mime_type;
pub(crate) mod models;
mod operations;
pub(crate) mod persistence;
mod queries;
pub(crate) mod schema;
pub mod schema_versions;
pub mod sorting;
pub mod stats;
pub mod types;
mod util;

// Re-export the main API types
pub use create::{create_target_blocker, CreateTargetBlocker};
pub use custom_columns::{CustomColumn, CustomColumnKind, CustomColumnSpec, CustomValue};
pub use error::CalibreError;
pub use library::{
    Author as LibraryAuthor, AuthorAdd, AuthorUpdate, Book as LibraryBook, BookAdd, BookFileInfo,
    BookIdentifier, BookPage, BookQuery, BookSortOrder, BookUpdate, CatalogFacetKind,
    CatalogFacetSummary, CustomValueFilter, CustomValueSummary, Library, PublisherSummary,
    ResolvedBookAsset, SeriesSummary, TagSummary, DEFAULT_READ_COLUMN,
};
pub use schema_versions::{
    peek_schema_version, SchemaUpgrade, MINIMUM_SCHEMA_VERSION, SCHEMA_VERSION,
};
pub use stats::{library_stats, LibraryStats};
pub use types::{AuthorId, BookFileId, BookId};
pub use util::is_library;

/// Connection helpers for libcalibre's own tests, examples and benchmarks.
/// Not part of the public API: no stability guarantees.
#[cfg(feature = "__internals")]
#[doc(hidden)]
pub mod __internals {
    pub use crate::persistence::*;
}

// Keep entity exports that are needed internally (for operations/queries)
pub(crate) use entities::{
    author::Author, book_file::BookFile, book_row::BookRow, book_row::NewBook,
    book_row::UpdateBookData, tag::Tag,
};
