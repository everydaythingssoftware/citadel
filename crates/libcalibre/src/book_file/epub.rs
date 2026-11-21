use std::{fs::File, io::BufReader, path::Path, str::FromStr};

use chrono::NaiveDate;
use citadel_epub::{Epub, EpubError};

use super::{
    guarded, non_empty, BookFileContents, BookFileMetadata, RefusedBookFile, MAX_COVER_BYTES,
};
use crate::mime_type::MimeType;

/// Reads the EPUB at `path` with one pass over its archive. A panic or an
/// unreadable file gives `Ok(None)`; a file past citadel-epub's limits is
/// refused.
pub(super) fn read_book(path: &Path) -> Result<Option<BookFileContents>, RefusedBookFile> {
    let Ok(file) = File::open(path) else {
        return Ok(None);
    };
    match guarded(|| Some(read_from(BufReader::new(file)))) {
        Some(Ok(book)) => Ok(Some(book)),
        Some(Err(EpubError::Refused(refusal))) => Err(RefusedBookFile::new(refusal.to_string())),
        Some(Err(EpubError::Unreadable(_))) | None => Ok(None),
    }
}

fn read_from(reader: BufReader<File>) -> Result<BookFileContents, EpubError> {
    let mut epub = Epub::open(reader)?;
    // A cover that can't be read leaves the book without one.
    let cover = epub.cover(MAX_COVER_BYTES).ok().flatten();
    let package = epub.package();
    let metadata = BookFileMetadata {
        format: MimeType::EPUB,
        title: package.title.as_deref().and_then(non_empty),
        author_names: package
            .authors()
            .filter_map(|author| non_empty(&author.name))
            .collect(),
        identifier: package.identifier.as_deref().and_then(non_empty),
        publisher: package.publisher.as_deref().and_then(non_empty),
        language: package.language().and_then(non_empty),
        tags: package
            .subjects
            .iter()
            .filter_map(|subject| non_empty(subject))
            .collect(),
        publication_date: package.published.as_deref().and_then(publication_date),
        has_cover: cover.is_some(),
    };
    Ok(BookFileContents { metadata, cover })
}

/// The calendar date at the start of an ISO 8601 date or date-time.
fn publication_date(date: &str) -> Option<NaiveDate> {
    NaiveDate::from_str(date.trim().get(..10)?).ok()
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    use super::*;
    use crate::book_file::{cover_image_data, read_book, read_metadata};

    struct Epub<'a> {
        opf_metadata: &'a str,
        manifest: &'a str,
        files: Vec<(&'a str, Vec<u8>)>,
    }

    impl Epub<'_> {
        fn write(&self, path: &Path) {
            let mut zip = ZipWriter::new(File::create(path).unwrap());
            let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            let deflated =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            zip.start_file("mimetype", stored).unwrap();
            zip.write_all(b"application/epub+zip").unwrap();
            zip.start_file("META-INF/container.xml", deflated).unwrap();
            zip.write_all(br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
            zip.start_file("OEBPS/content.opf", deflated).unwrap();
            write!(
                zip,
                r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">{}</metadata><manifest><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>{}</manifest><spine><itemref idref="text"/></spine></package>"#,
                self.opf_metadata, self.manifest
            )
            .unwrap();
            zip.start_file("OEBPS/text.xhtml", deflated).unwrap();
            zip.write_all(
                b"<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>Text</p></body></html>",
            )
            .unwrap();
            for (name, data) in &self.files {
                zip.start_file(*name, deflated).unwrap();
                zip.write_all(data).unwrap();
            }
            zip.finish().unwrap();
        }
    }

    const METADATA: &str = r#"<dc:identifier id="id">urn:isbn:9780140449136</dc:identifier><dc:title>The Odyssey</dc:title><dc:creator>Homer</dc:creator><dc:creator> </dc:creator><dc:creator>Emily Wilson</dc:creator><dc:language>en</dc:language><dc:publisher>Penguin</dc:publisher><dc:date>2018-11-06</dc:date><dc:subject>Epic poetry</dc:subject><meta name="cover" content="cover"/>"#;

    fn write(dir: &tempfile::TempDir, epub: Epub) -> std::path::PathBuf {
        let path = dir.path().join("book.epub");
        epub.write(&path);
        path
    }

    #[test]
    fn reads_package_metadata_and_cover() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            &dir,
            Epub {
                opf_metadata: METADATA,
                manifest: r#"<item id="cover" href="images/cover.jpg" media-type="image/jpeg"/>"#,
                files: vec![("OEBPS/images/cover.jpg", b"jpeg bytes".to_vec())],
            },
        );

        let metadata = read_metadata(&path).unwrap();
        assert_eq!(
            metadata,
            BookFileMetadata {
                format: MimeType::EPUB,
                title: Some("The Odyssey".into()),
                author_names: vec!["Homer".into(), "Emily Wilson".into()],
                identifier: Some("urn:isbn:9780140449136".into()),
                publisher: Some("Penguin".into()),
                language: Some("en".into()),
                tags: vec!["Epic poetry".into()],
                publication_date: NaiveDate::from_ymd_opt(2018, 11, 6),
                has_cover: true,
            }
        );
        assert_eq!(cover_image_data(&path).unwrap(), b"jpeg bytes");
    }

    #[test]
    fn finds_epub3_cover_image_property() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            &dir,
            Epub {
                opf_metadata: r#"<dc:identifier id="id">x</dc:identifier><dc:title>T</dc:title>"#,
                manifest: r#"<item id="c" href="c%20over.png" media-type="image/png" properties="cover-image"/>"#,
                files: vec![("OEBPS/c over.png", b"png bytes".to_vec())],
            },
        );
        assert_eq!(cover_image_data(&path).unwrap(), b"png bytes");
    }

    #[test]
    fn oversized_or_missing_covers_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            &dir,
            Epub {
                opf_metadata: METADATA,
                manifest: r#"<item id="cover" href="cover.jpg" media-type="image/jpeg"/>"#,
                files: vec![("OEBPS/cover.jpg", vec![0; MAX_COVER_BYTES as usize + 1])],
            },
        );
        assert_eq!(cover_image_data(&path), None);
        assert!(!read_metadata(&path).unwrap().has_cover);

        let path = write(
            &dir,
            Epub {
                opf_metadata: METADATA,
                manifest: r#"<item id="cover" href="gone.jpg" media-type="image/jpeg"/>"#,
                files: vec![],
            },
        );
        assert_eq!(cover_image_data(&path), None);
    }

    #[test]
    fn unreadable_files_have_no_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("broken.epub");
        std::fs::write(&path, b"not a zip").unwrap();
        assert_eq!(read_metadata(&path), None);
        assert_eq!(cover_image_data(&path), None);
        assert_eq!(read_book(&path), Ok(None));
    }

    #[test]
    fn one_read_gives_metadata_and_cover() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            &dir,
            Epub {
                opf_metadata: r##"<dc:identifier id="id">x</dc:identifier><dc:title>T</dc:title><dc:creator id="t">Ann Translator</dc:creator><meta refines="#t" property="role" scheme="marc:relators">trl</meta><dc:creator>Author</dc:creator><dc:date>2018-11-06T00:00:00Z</dc:date>"##,
                manifest: r#"<item id="c" href="c.png" media-type="image/png" properties="cover-image"/>"#,
                files: vec![("OEBPS/c.png", b"png bytes".to_vec())],
            },
        );
        let book = read_book(&path).unwrap().unwrap();
        assert_eq!(book.cover.as_deref(), Some(&b"png bytes"[..]));
        assert!(book.metadata.has_cover);
        assert_eq!(book.metadata.author_names, vec!["Author"]);
        assert_eq!(
            book.metadata.publication_date,
            NaiveDate::from_ymd_opt(2018, 11, 6)
        );
    }

    #[test]
    fn files_past_the_limits_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let nested = format!(
            "{}{}<dc:title>T</dc:title>",
            "<x>".repeat(1000),
            "</x>".repeat(1000)
        );
        let path = write(
            &dir,
            Epub {
                opf_metadata: &nested,
                manifest: "",
                files: vec![],
            },
        );
        let refused = read_book(&path).unwrap_err();
        assert_eq!(
            refused.reason(),
            "This EPUB's package file nests elements more than 256 deep."
        );
        assert_eq!(read_metadata(&path), None);
        assert_eq!(cover_image_data(&path), None);
    }
}
