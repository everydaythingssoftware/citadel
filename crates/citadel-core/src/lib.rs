//! Platform-agnostic core for Citadel.
//!
//! Owns the frontend-facing DTOs ([`LibraryBook`], [`LibraryAuthor`],
//! [`LocalOrRemoteUrl`], the file list) and the conversion from a `libcalibre`
//! [`Book`](libcalibre::Book) into them. None of this depends on
//! Tauri. Shared queries and mutations live in [`library::LibraryService`], with
//! serializable inputs in [`contracts`] and transport-independent [`error`] codes.
//! Every write names the [`Actor`] it is performed for. [`store`] owns
//! `citadel.db`: users, sessions, the library registry and grants.
//! The cover/file URL scheme is injected through [`BookUrlBuilder`]: desktop
//! supplies [`AssetUrlBuilder`] and the server supplies [`HttpUrlBuilder`].

mod actor;
mod author;
mod book;
mod url;
mod words;

pub use actor::Actor;
pub use author::LibraryAuthor;
pub use book::{
    BookFile, Identifier, LibraryBook, LocalFile, LocalOrRemote, LocalOrRemoteUrl, RemoteFile,
};
pub use url::{path_to_asset_url, AssetUrlBuilder, BookUrlBuilder, HttpUrlBuilder};

pub mod contracts;
pub mod error;
pub mod genres;
pub mod library;
pub mod password;
pub mod store;
pub mod vault;

/// Names Citadel as the producer in each book's `metadata.opf`.
pub const OPF_PRODUCER: &str = "citadel [https://github.com/every-day-things/citadel]";

/// Applies Citadel's settings to a library handle it opened for writing.
pub fn configure_library(library: libcalibre::Library) -> libcalibre::Library {
    library.with_opf_producer(OPF_PRODUCER)
}
