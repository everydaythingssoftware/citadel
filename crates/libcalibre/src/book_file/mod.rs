//! Reads metadata and cover images from book files before they are added to a
//! library. Every host shares this, so file-format quirks live in one place.
use std::{ffi::OsStr, path::Path};

use chrono::NaiveDate;

use crate::mime_type::MIMETYPE;

mod epub;
mod mobi;

/// Covers larger than this are ignored rather than read into memory; a
/// compressed EPUB entry can otherwise expand without bound.
pub const MAX_COVER_BYTES: u64 = 16 * 1024 * 1024;

/// What a book file says about itself. Formats without embedded metadata
/// (PDF, TXT) report only a title taken from the file name.
#[derive(Clone, Debug, PartialEq)]
pub struct BookFileMetadata {
    pub format: MIMETYPE,
    pub title: Option<String>,
    pub author_names: Vec<String>,
    pub identifier: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub tags: Vec<String>,
    pub publication_date: Option<NaiveDate>,
    pub has_cover: bool,
}

impl BookFileMetadata {
    fn titled_from_file_name(format: MIMETYPE, path: &Path) -> Option<Self> {
        Some(Self {
            format,
            title: non_empty(path.file_stem()?.to_str()?),
            author_names: Vec::new(),
            identifier: None,
            publisher: None,
            language: None,
            tags: Vec::new(),
            publication_date: None,
            has_cover: false,
        })
    }
}

fn format_of(path: &Path) -> Option<MIMETYPE> {
    path.extension()
        .and_then(OsStr::to_str)
        .and_then(MIMETYPE::from_file_extension)
}

/// Reads the metadata of the book file at `path`, choosing the reader by file
/// extension. `None` when the extension is unsupported or the file can't be
/// parsed.
pub fn read_metadata(path: &Path) -> Option<BookFileMetadata> {
    match format_of(path)? {
        MIMETYPE::EPUB => epub::read_metadata(path),
        format @ (MIMETYPE::MOBI | MIMETYPE::KF7 | MIMETYPE::KF8) => {
            mobi::read_metadata(path, format)
        }
        format @ (MIMETYPE::PDF | MIMETYPE::TXT) => {
            BookFileMetadata::titled_from_file_name(format, path)
        }
        MIMETYPE::UNKNOWN => None,
    }
}

/// The cover image embedded in the book file at `path`, if it has one no
/// larger than [`MAX_COVER_BYTES`].
pub fn cover_image_data(path: &Path) -> Option<Vec<u8>> {
    match format_of(path)? {
        MIMETYPE::EPUB => epub::cover_image_data(path),
        MIMETYPE::MOBI | MIMETYPE::KF7 | MIMETYPE::KF8 => mobi::cover_image_data(path),
        _ => None,
    }
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_formats_are_titled_from_their_file_name() {
        let metadata = read_metadata(Path::new("/books/The Odyssey.pdf")).unwrap();
        assert_eq!(metadata.format, MIMETYPE::PDF);
        assert_eq!(metadata.title.as_deref(), Some("The Odyssey"));
        assert!(!metadata.has_cover);
        assert_eq!(
            read_metadata(Path::new("/books/notes.TXT")).unwrap().format,
            MIMETYPE::TXT
        );
    }

    #[test]
    fn unsupported_extensions_have_no_metadata_or_cover() {
        assert_eq!(read_metadata(Path::new("/books/archive.zip")), None);
        assert_eq!(read_metadata(Path::new("/books/no-extension")), None);
        assert_eq!(cover_image_data(Path::new("/books/archive.zip")), None);
    }
}
