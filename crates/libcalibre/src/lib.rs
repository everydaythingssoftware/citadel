mod assets;
mod cover_image;
mod custom_columns;
mod entities;
pub mod error;
pub mod library;
pub mod mime_type;
pub(crate) mod models;
mod operations;
pub mod persistence;
mod queries;
pub(crate) mod schema;
pub mod sorting;
pub mod stats;
pub mod types;
pub mod util;

// Re-export the main API types
pub use custom_columns::{CustomColumn, CustomColumnKind, CustomColumnSpec, CustomValue};
pub use error::CalibreError;
pub use library::{
    Author as LibraryAuthor, AuthorAdd, AuthorUpdate, Book as LibraryBook, BookAdd, BookFileInfo,
    BookIdentifier, BookPage, BookQuery, BookSortOrder, BookUpdate, Library, SeriesSummary,
    TagSummary,
};
pub use stats::{library_stats, LibraryStats};
pub use types::{AuthorId, BookFileId, BookId};

// Keep entity exports that are needed internally (for operations/queries)
pub(crate) use entities::{
    author::Author, book_file::BookFile, book_row::BookRow, book_row::NewBook,
    book_row::UpdateBookData, tag::Tag,
};
