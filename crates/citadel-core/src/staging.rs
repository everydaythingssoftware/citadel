//! Books waiting for review before they join a library: what a book file
//! says about itself, and the reviewed metadata it is added with. The server
//! stages uploaded files; the desktop stages files where they already are.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use chrono::NaiveDate;
use libcalibre::{book_file, mime_type::MIMETYPE};
use serde::{Deserialize, Serialize};

use crate::error::LibraryError;

/// What the uploaded file says about itself, for the user to review.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StagedBook {
    /// The file's format, as its extension (`epub`, `azw3`, …).
    pub format: String,
    /// The file's own title, or its name when it has none.
    pub title: String,
    pub author_names: Vec<String>,
    pub identifier: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub tags: Vec<String>,
    pub publication_date: Option<NaiveDate>,
    pub cover_url: Option<String>,
}

/// The metadata the user reviewed, to add the upload to the library with.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitUpload {
    pub title: String,
    #[serde(default)]
    pub author_names: Vec<String>,
    /// Stored as the book's ISBN when it is one (`urn:isbn:` and `ISBN:`
    /// prefixes are accepted); other identifiers are ignored.
    pub identifier: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub publication_date: Option<NaiveDate>,
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn trimmed_list(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .filter_map(|value| trimmed(Some(value)))
        .collect()
}

impl CommitUpload {
    /// The book to add from `file`, with blank fields left out. Refused
    /// without a title.
    pub fn into_book_add(self, file: PathBuf) -> Result<libcalibre::BookAdd, LibraryError> {
        let title = trimmed(Some(self.title))
            .ok_or_else(|| LibraryError::invalid("A book needs a title"))?;
        let identifiers = trimmed(self.identifier)
            .as_deref()
            .and_then(book_file::isbn)
            .map(|isbn| HashMap::from([("isbn".to_string(), isbn)]))
            .unwrap_or_default();
        let tags = trimmed_list(self.tags);
        Ok(libcalibre::BookAdd {
            title,
            author_names: trimmed_list(self.author_names),
            tags: (!tags.is_empty()).then_some(tags),
            series: None,
            series_index: None,
            publisher: trimmed(self.publisher),
            publication_date: self.publication_date,
            rating: None,
            comments: None,
            language: trimmed(self.language),
            identifiers,
            file_paths: vec![file],
        })
    }
}

/// A file's lowercase extension and the format it names, or why Citadel
/// can't add it.
pub fn book_format(file_name: &str) -> Result<(String, MIMETYPE), LibraryError> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let format = MIMETYPE::from_file_extension(&extension).ok_or_else(|| {
        LibraryError::invalid("Citadel can import EPUB, MOBI, AZW, AZW3, PDF and TXT files")
    })?;
    Ok((extension, format))
}

/// A book file read for review, with its embedded cover's bytes as stored.
pub struct ReadBook {
    pub book: StagedBook,
    pub cover: Option<Vec<u8>>,
}

/// Reads the book file at `path`. `file_name` is the name the person knows
/// it by, which titles PDF and TXT files (and anything without a title of
/// its own) whatever the file is called on disk. The cover URL is left for
/// the host to fill in once it has stored a preview.
pub fn read_book_file(path: &Path, file_name: &str, extension: String) -> ReadBook {
    let metadata = book_file::read_metadata(path);
    let cover = metadata
        .as_ref()
        .is_some_and(|metadata| metadata.has_cover)
        .then(|| book_file::cover_image_data(path))
        .flatten();
    let fallback_title = Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(file_name)
        .to_string();
    let metadata = metadata.unwrap_or(book_file::BookFileMetadata {
        format: MIMETYPE::UNKNOWN,
        title: None,
        author_names: Vec::new(),
        identifier: None,
        publisher: None,
        language: None,
        tags: Vec::new(),
        publication_date: None,
        has_cover: false,
    });
    let title = match metadata.format {
        MIMETYPE::PDF | MIMETYPE::TXT => None,
        _ => metadata.title,
    };
    ReadBook {
        book: StagedBook {
            format: extension,
            title: title.unwrap_or(fallback_title),
            author_names: metadata.author_names,
            identifier: metadata.identifier,
            publisher: metadata.publisher,
            language: metadata.language,
            tags: metadata.tags,
            publication_date: metadata.publication_date,
            cover_url: None,
        },
        cover,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn review(title: &str) -> CommitUpload {
        CommitUpload {
            title: title.to_string(),
            author_names: vec!["  Ann Author ".into(), " ".into()],
            identifier: Some("urn:isbn:978-0-306-40615-7".into()),
            publisher: Some("   ".into()),
            language: Some(" fra ".into()),
            tags: vec![" ".into()],
            publication_date: None,
        }
    }

    #[test]
    fn reviewed_books_are_trimmed_and_keep_only_an_isbn() {
        let book = review("  Walden ")
            .into_book_add(PathBuf::from("/books/walden.epub"))
            .unwrap();
        assert_eq!(book.title, "Walden");
        assert_eq!(book.author_names, vec!["Ann Author"]);
        assert_eq!(book.tags, None);
        assert_eq!(book.publisher, None);
        assert_eq!(book.language.as_deref(), Some("fra"));
        assert_eq!(
            book.identifiers.get("isbn").map(String::as_str),
            Some("9780306406157")
        );
        assert_eq!(book.file_paths, vec![PathBuf::from("/books/walden.epub")]);

        let mut other = review("Walden");
        other.identifier = Some("urn:uuid:1234".into());
        assert!(other
            .into_book_add(PathBuf::new())
            .unwrap()
            .identifiers
            .is_empty());
    }

    #[test]
    fn a_reviewed_book_needs_a_title() {
        assert!(review("   ").into_book_add(PathBuf::new()).is_err());
    }

    #[test]
    fn formats_come_from_the_extension() {
        assert_eq!(book_format("Walden.EPUB").unwrap().0, "epub");
        assert!(book_format("notes.docx").is_err());
        assert!(book_format("README").is_err());
    }

    #[test]
    fn files_without_metadata_are_titled_by_their_name() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("0f3c.txt");
        std::fs::write(&path, "Call me Ishmael.").unwrap();
        let read = read_book_file(&path, "Moby Dick.txt", "txt".into());
        assert_eq!(read.book.title, "Moby Dick");
        assert_eq!(read.book.format, "txt");
        assert!(read.cover.is_none());
    }
}
