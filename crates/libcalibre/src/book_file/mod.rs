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

/// Bytes [`content_matches`] needs from the start of a file to decide.
pub const CONTENT_CHECK_BYTES: usize = 1024;

/// Whether `head` (the first bytes of a file, up to [`CONTENT_CHECK_BYTES`])
/// looks like a `format` file, so a file can't be imported under a format it
/// isn't. TXT has no signature; it only has to look like text.
pub fn content_matches(format: MIMETYPE, head: &[u8]) -> bool {
    match format {
        // Strictly the first entry is a stored `mimetype`, but many EPUBs
        // in the wild get that wrong; the reader validates the rest.
        MIMETYPE::EPUB => head.starts_with(b"PK\x03\x04"),
        MIMETYPE::PDF => head
            .windows(5)
            .take(CONTENT_CHECK_BYTES)
            .any(|window| window == b"%PDF-"),
        // PalmDB type and creator.
        MIMETYPE::MOBI | MIMETYPE::KF7 | MIMETYPE::KF8 => head.get(60..68) == Some(b"BOOKMOBI"),
        MIMETYPE::TXT => !head.contains(&0),
        MIMETYPE::UNKNOWN => false,
    }
}

/// The ISBN-10 or ISBN-13 in a book file's identifier (`urn:isbn:` and
/// `ISBN:` prefixes, hyphens and spaces allowed), or `None` when the
/// identifier isn't an ISBN.
pub fn isbn(identifier: &str) -> Option<String> {
    let identifier = identifier.trim();
    let lower = identifier.to_ascii_lowercase();
    let bare = ["urn:isbn:", "isbn:"]
        .iter()
        .find_map(|prefix| {
            lower
                .starts_with(prefix)
                .then(|| &identifier[prefix.len()..])
        })
        .unwrap_or(identifier);
    let digits: Vec<char> = bare
        .chars()
        .filter(|c| !matches!(c, '-' | ' '))
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let valid = match digits.as_slice() {
        [body @ .., check] if digits.len() == 10 => {
            body.iter().all(char::is_ascii_digit) && (check.is_ascii_digit() || *check == 'X')
        }
        all if all.len() == 13 => all.iter().all(char::is_ascii_digit),
        _ => false,
    };
    valid.then(|| digits.into_iter().collect())
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
    fn content_must_match_the_format() {
        let mut mobi = vec![0u8; 68];
        mobi[60..68].copy_from_slice(b"BOOKMOBI");
        assert!(content_matches(MIMETYPE::EPUB, b"PK\x03\x04mimetype"));
        assert!(content_matches(MIMETYPE::PDF, b"\xEF\xBB\xBF%PDF-1.7"));
        assert!(content_matches(MIMETYPE::KF8, &mobi));
        assert!(content_matches(
            MIMETYPE::TXT,
            "Call me Ishmael. ✓".as_bytes()
        ));

        assert!(!content_matches(MIMETYPE::EPUB, b"%PDF-1.7"));
        assert!(!content_matches(MIMETYPE::PDF, b"PK\x03\x04"));
        assert!(!content_matches(MIMETYPE::MOBI, &mobi[..67]));
        assert!(!content_matches(MIMETYPE::TXT, b"MZ\x90\x00"));
        assert!(!content_matches(MIMETYPE::UNKNOWN, b"anything"));
    }

    #[test]
    fn isbns_are_normalized_and_other_identifiers_dropped() {
        assert_eq!(
            isbn("urn:isbn:978-0-14-044913-6").as_deref(),
            Some("9780140449136")
        );
        assert_eq!(isbn("ISBN:0 14 044913 X").as_deref(), Some("014044913X"));
        assert_eq!(isbn("9780140449136").as_deref(), Some("9780140449136"));
        assert_eq!(isbn("urn:uuid:5b1f3c1e-0000-4000-8000-000000000000"), None);
        assert_eq!(isbn("97801404491"), None);
        assert_eq!(isbn("ISBN:é123456789"), None);
    }

    #[test]
    fn unsupported_extensions_have_no_metadata_or_cover() {
        assert_eq!(read_metadata(Path::new("/books/archive.zip")), None);
        assert_eq!(read_metadata(Path::new("/books/no-extension")), None);
        assert_eq!(cover_image_data(Path::new("/books/archive.zip")), None);
    }
}
