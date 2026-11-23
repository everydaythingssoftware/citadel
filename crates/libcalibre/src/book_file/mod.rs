//! Reads metadata and cover images from book files before they are added to a
//! library. Every host shares this, so file-format quirks live in one place.
//!
//! EPUB and MOBI files are parsed with the `epub` and `mobi` features (both on
//! by default). Without one, files of that format are read like PDFs: a title
//! from the file name and no cover. EPUBs are read by `citadel-epub`, within
//! fixed limits; a file past them is [refused](RefusedBookFile).
use std::{ffi::OsStr, path::Path};

use chrono::NaiveDate;

use crate::mime_type::MimeType;

#[cfg(feature = "epub")]
mod epub;
#[cfg(feature = "mobi")]
mod mobi;

/// Covers larger than this are ignored rather than read into memory; a
/// compressed EPUB entry can otherwise expand without bound.
#[cfg(any(feature = "epub", feature = "mobi"))]
pub(crate) const MAX_COVER_BYTES: u64 = 16 * 1024 * 1024;

/// What a book file says about itself. Formats without embedded metadata
/// (PDF, TXT) report only a title taken from the file name.
#[derive(Clone, Debug, PartialEq)]
pub struct BookFileMetadata {
    /// The file's format, from its extension.
    pub format: MimeType,
    /// The embedded title, or for PDF and TXT the file name without
    /// extension.
    pub title: Option<String>,
    /// Author names, in file order; blank names are dropped. For an EPUB,
    /// creators without a non-author role (translators, editors, …) and
    /// contributors with the author role.
    pub author_names: Vec<String>,
    /// The book's identifier as the file gives it: the EPUB `dc:identifier`
    /// its package names as unique, or else its first (often `urn:isbn:...`
    /// or `urn:uuid:...`), or a MOBI's ISBN as `ISBN:...`. [`isbn`]
    /// extracts an ISBN from it.
    pub identifier: Option<String>,
    /// The publisher.
    pub publisher: Option<String>,
    /// An EPUB's `dc:language` as written (usually a code such as `en`), or
    /// a MOBI's language as an English name such as `English`.
    pub language: Option<String>,
    /// Subjects (EPUB `dc:subject`, MOBI subject records).
    pub tags: Vec<String>,
    /// The publication date, when the file gives one that parses.
    pub publication_date: Option<NaiveDate>,
    /// Whether the file embeds a cover that [`cover_image_data`] can read.
    pub has_cover: bool,
}

impl BookFileMetadata {
    fn titled_from_file_name(format: MimeType, path: &Path) -> Option<Self> {
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

/// A book file read in one pass: what it says about itself and the bytes of
/// its embedded cover, as stored.
#[derive(Clone, Debug, PartialEq)]
pub struct BookFileContents {
    /// What the file says about itself.
    pub metadata: BookFileMetadata,
    /// The embedded cover, when it has one no larger than 16 MiB.
    pub cover: Option<Vec<u8>>,
}

/// A book file Citadel won't read, such as an EPUB that breaks a parsing
/// limit. Unlike a damaged file, it shouldn't be added at all.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{reason}")]
pub struct RefusedBookFile {
    reason: String,
}

impl RefusedBookFile {
    #[cfg_attr(not(feature = "epub"), allow(dead_code))]
    fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }

    /// Why, in a sentence for the person who chose the file.
    pub fn reason(&self) -> &str {
        &self.reason
    }
}

fn format_of(path: &Path) -> Option<MimeType> {
    path.extension()
        .and_then(OsStr::to_str)
        .and_then(MimeType::from_file_extension)
}

/// Runs `read`, counting a panic in a format parser as an unreadable file.
#[cfg(any(feature = "epub", feature = "mobi"))]
fn guarded<T>(read: impl FnOnce() -> Option<T>) -> Option<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(read))
        .ok()
        .flatten()
}

/// Reads the book file at `path` once, for both its metadata and its cover,
/// choosing the reader by file extension. `Ok(None)` when the extension is
/// unsupported or the file can't be parsed; `Err` when it is refused.
pub fn read_book(path: &Path) -> Result<Option<BookFileContents>, RefusedBookFile> {
    let Some(format) = format_of(path) else {
        return Ok(None);
    };
    Ok(match format {
        #[cfg(feature = "epub")]
        MimeType::EPUB => return epub::read_book(path),
        #[cfg(feature = "mobi")]
        format @ (MimeType::MOBI | MimeType::KF7 | MimeType::KF8) => mobi::read_book(path, format),
        MimeType::UNKNOWN => None,
        format => {
            BookFileMetadata::titled_from_file_name(format, path).map(|metadata| BookFileContents {
                metadata,
                cover: None,
            })
        }
    })
}

/// Reads the metadata of the book file at `path`, choosing the reader by file
/// extension. `None` when the extension is unsupported or the file can't be
/// parsed or is refused.
pub fn read_metadata(path: &Path) -> Option<BookFileMetadata> {
    match format_of(path)? {
        #[cfg(feature = "mobi")]
        format @ (MimeType::MOBI | MimeType::KF7 | MimeType::KF8) => {
            mobi::read_metadata(path, format)
        }
        _ => read_book(path).ok().flatten().map(|book| book.metadata),
    }
}

/// The cover image embedded in the book file at `path`, if it has one no
/// larger than 16 MiB and the file isn't refused.
pub fn cover_image_data(path: &Path) -> Option<Vec<u8>> {
    match format_of(path)? {
        #[cfg(feature = "epub")]
        MimeType::EPUB => read_book(path).ok().flatten()?.cover,
        #[cfg(feature = "mobi")]
        MimeType::MOBI | MimeType::KF7 | MimeType::KF8 => mobi::cover_image_data(path),
        _ => None,
    }
}

/// Bytes [`content_matches`] needs from the start of a file to decide.
pub const CONTENT_CHECK_BYTES: usize = 1024;

/// Whether `head` (the first bytes of a file, up to [`CONTENT_CHECK_BYTES`])
/// looks like a `format` file, so a file can't be imported under a format it
/// isn't. TXT has no signature; it only has to look like text.
pub fn content_matches(format: MimeType, head: &[u8]) -> bool {
    match format {
        // Strictly the first entry is a stored `mimetype`, but many EPUBs
        // in the wild get that wrong; the reader validates the rest.
        MimeType::EPUB => head.starts_with(b"PK\x03\x04"),
        MimeType::PDF => head
            .windows(5)
            .take(CONTENT_CHECK_BYTES)
            .any(|window| window == b"%PDF-"),
        // PalmDB type and creator.
        MimeType::MOBI | MimeType::KF7 | MimeType::KF8 => head.get(60..68) == Some(b"BOOKMOBI"),
        MimeType::TXT => !head.contains(&0),
        MimeType::UNKNOWN => false,
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
        assert_eq!(metadata.format, MimeType::PDF);
        assert_eq!(metadata.title.as_deref(), Some("The Odyssey"));
        assert!(!metadata.has_cover);
        assert_eq!(
            read_metadata(Path::new("/books/notes.TXT")).unwrap().format,
            MimeType::TXT
        );
    }

    #[test]
    fn content_must_match_the_format() {
        let mut mobi = vec![0u8; 68];
        mobi[60..68].copy_from_slice(b"BOOKMOBI");
        assert!(content_matches(MimeType::EPUB, b"PK\x03\x04mimetype"));
        assert!(content_matches(MimeType::PDF, b"\xEF\xBB\xBF%PDF-1.7"));
        assert!(content_matches(MimeType::KF8, &mobi));
        assert!(content_matches(
            MimeType::TXT,
            "Call me Ishmael. ✓".as_bytes()
        ));

        assert!(!content_matches(MimeType::EPUB, b"%PDF-1.7"));
        assert!(!content_matches(MimeType::PDF, b"PK\x03\x04"));
        assert!(!content_matches(MimeType::MOBI, &mobi[..67]));
        assert!(!content_matches(MimeType::TXT, b"MZ\x90\x00"));
        assert!(!content_matches(MimeType::UNKNOWN, b"anything"));
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
