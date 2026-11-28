#![warn(missing_docs)]
#![doc = include_str!("../README.md")]

mod assets;
pub mod book_file;
mod create;
mod custom_columns;
mod entities;
mod error;
mod library;
pub mod matching;
/// Book file formats and their MIME types and extensions.
pub mod mime_type;
mod models;
mod operations;
#[allow(missing_docs)]
mod persistence;
mod queries;
mod schema;
mod schema_versions;
/// Calibre-compatible sort keys for book titles and author names.
pub mod sorting;
mod stats;
mod types;
mod util;

pub use create::{create_target_blocker, CreateTargetBlocker};
pub use custom_columns::{CustomColumn, CustomColumnKind, CustomColumnSpec, CustomValue};
pub use error::CalibreError;
pub use library::{
    Author, AuthorAdd, AuthorUpdate, Book, BookAdd, BookFileInfo, BookIdentifier, BookPage,
    BookQuery, BookSortOrder, BookUpdate, CatalogFacetKind, CatalogFacetSummary, CustomValueFilter,
    CustomValueSummary, Library, PublisherSummary, ResolvedBookAsset, SeriesSummary, TagSummary,
    DEFAULT_READ_COLUMN, MAX_DUPLICATES,
};
pub use schema_versions::{
    backups as upgrade_backups, peek_schema_version, SchemaUpgrade, MINIMUM_SCHEMA_VERSION,
    SCHEMA_VERSION,
};
pub use stats::{library_stats, LibraryStats};
pub use types::{AuthorId, BookId};
pub use util::is_library;

/// Connection helpers for libcalibre's own tests, examples and benchmarks.
/// Not part of the public API: no stability guarantees.
#[cfg(feature = "__internals")]
#[doc(hidden)]
pub mod __internals {
    pub use crate::persistence::*;
}

pub(crate) use entities::{
    book_file::BookFile, book_row::BookRow, book_row::NewBook, book_row::UpdateBookData, tag::Tag,
};
