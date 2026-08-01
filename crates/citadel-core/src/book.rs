use std::{collections::HashMap, path::PathBuf};

use serde::{Deserialize, Serialize};

use crate::author::LibraryAuthor;
use crate::url::BookUrlBuilder;

#[derive(Serialize, specta::Type, Deserialize, Clone)]
pub enum LocalOrRemote {
    Local,
    Remote,
}

#[derive(Serialize, specta::Type, Deserialize, Clone)]
pub struct LocalOrRemoteUrl {
    pub kind: LocalOrRemote,
    pub url: String,
    pub local_path: Option<PathBuf>,
}

#[derive(Serialize, specta::Type, Deserialize, Clone, Debug)]
pub struct LocalFile {
    /// The absolute path to the file, including extension.
    pub path: PathBuf,
    /// The MIME type of the file. Common values are `application/pdf` and `application/epub+zip`.
    pub mime_type: String,
}

#[derive(Serialize, specta::Type, Deserialize, Clone, Debug)]
pub struct RemoteFile {
    pub url: String,
}

#[derive(Serialize, specta::Type, Deserialize, Clone, Debug)]
pub enum BookFile {
    Local(LocalFile),
    Remote(RemoteFile),
}

#[derive(Serialize, specta::Type, Deserialize, Clone)]
pub struct LibraryBook {
    pub id: String,
    pub uuid: Option<String>,
    pub title: String,
    pub author_list: Vec<LibraryAuthor>,
    pub tag_list: Vec<String>,

    pub sortable_title: Option<String>,

    pub file_list: Vec<BookFile>,

    pub cover_image: Option<LocalOrRemoteUrl>,

    pub identifier_list: Vec<Identifier>,

    pub description: Option<String>,

    pub is_read: bool,

    pub series: Option<String>,
    pub series_index: Option<f32>,

    /// Canonical Calibre language codes (ISO 639-2/3, e.g. `eng`, `fra`),
    /// ordered. Empty when the book has no language metadata.
    pub language_list: Vec<String>,
}

impl LibraryBook {
    /// Build the frontend DTO from a hydrated `libcalibre` book.
    ///
    /// `url_builder` decides the cover/file URL scheme — the Tauri app passes
    /// an [`AssetUrlBuilder`](crate::AssetUrlBuilder), a server passes an
    /// [`HttpUrlBuilder`](crate::HttpUrlBuilder). `cache_bust_cover` is a hint
    /// forwarded to the builder (the asset builder appends the cover's mtime so
    /// the webview re-fetches a replaced cover; see [`AssetUrlBuilder`]).
    pub fn from_library_book(
        book: &libcalibre::library::Book,
        library_path: &str,
        author_book_counts: &HashMap<libcalibre::AuthorId, i64>,
        url_builder: &dyn BookUrlBuilder,
        cache_bust_cover: bool,
    ) -> Self {
        Self {
            id: book.id.as_i32().to_string(),
            uuid: book.uuid.clone(),
            title: book.title.clone(),
            author_list: book
                .authors
                .iter()
                .map(|author| LibraryAuthor::from_author(author, author_book_counts))
                .collect(),
            tag_list: book.tags.clone(),
            sortable_title: book.sortable_title.clone(),
            identifier_list: book.identifiers.iter().map(Identifier::from).collect(),
            description: book.description.clone(),
            is_read: book.is_read,
            series: book.series.clone(),
            series_index: book.series_index,
            language_list: book.language_codes.clone(),
            cover_image: book_cover_url(book, library_path, url_builder, cache_bust_cover),
            file_list: book
                .files
                .iter()
                .map(|file| {
                    let file_name_with_ext =
                        format!("{}.{}", file.name, file.format.to_lowercase());
                    let file_path = PathBuf::from(library_path)
                        .join(&book.book_dir_path)
                        .join(file_name_with_ext);

                    url_builder.file_url(book, file, &file_path)
                })
                .collect(),
        }
    }
}

/// Build the cover-image URL for a book, or `None` when it has no cover.
///
/// Trusts the books table's `has_cover` flag rather than statting cover.jpg per
/// book — the per-book `exists` check dominated list rendering at thousands of
/// books. A stale flag yields a dangling URL, which the frontend's cover
/// `onerror` fallback absorbs.
fn book_cover_url(
    book: &libcalibre::library::Book,
    library_path: &str,
    url_builder: &dyn BookUrlBuilder,
    cache_bust: bool,
) -> Option<LocalOrRemoteUrl> {
    if !book.has_cover {
        return None;
    }

    let cover_relative_path = format!("{}/cover.jpg", &book.book_dir_path);
    let cover_image_path = PathBuf::from(library_path).join(&cover_relative_path);

    Some(url_builder.cover_url(book, &cover_image_path, cache_bust))
}

/// Book identifiers, such as ISBN, DOI, Google Books ID, etc.
#[derive(Serialize, Deserialize, Clone, specta::Type)]
pub struct Identifier {
    pub id: i32,
    pub label: String,
    pub value: String,
}

impl From<&libcalibre::BookIdentifier> for Identifier {
    fn from(identifier: &libcalibre::BookIdentifier) -> Self {
        Identifier {
            id: identifier.id,
            label: identifier.label.clone(),
            value: identifier.value.clone(),
        }
    }
}
