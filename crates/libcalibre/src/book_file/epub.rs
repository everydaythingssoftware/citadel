use std::{fs::File, io::Read, path::Path, str::FromStr};

use chrono::NaiveDate;
use epub::doc::EpubDoc;

use super::{non_empty, BookFileMetadata, MAX_COVER_BYTES};
use crate::mime_type::MIMETYPE;

pub(super) fn read_metadata(path: &Path) -> Option<BookFileMetadata> {
    let doc = EpubDoc::new(path).ok()?;
    let values = |property: &str| -> Vec<String> {
        doc.metadata
            .iter()
            .filter(|item| item.property == property)
            .filter_map(|item| non_empty(&item.value))
            .collect()
    };
    let value = |property: &str| doc.mdata(property).and_then(|item| non_empty(&item.value));

    Some(BookFileMetadata {
        format: MIMETYPE::EPUB,
        title: value("title"),
        author_names: values("creator"),
        identifier: value("identifier"),
        publisher: value("publisher"),
        language: value("language"),
        tags: values("subject"),
        publication_date: value("date").and_then(|date| NaiveDate::from_str(&date).ok()),
        has_cover: cover_from_doc(path, &doc).is_some(),
    })
}

pub(super) fn cover_image_data(path: &Path) -> Option<Vec<u8>> {
    let doc = EpubDoc::new(path).ok()?;
    cover_from_doc(path, &doc)
}

/// Reads the cover entry straight from the archive so its size can be capped;
/// the epub crate would read any entry to the end.
fn cover_from_doc<R: Read + std::io::Seek>(path: &Path, doc: &EpubDoc<R>) -> Option<Vec<u8>> {
    // EPUB3 marks the cover with `properties="cover-image"`; EPUB2 (and hybrid
    // EPUB3 books) name its manifest item with `<meta name="cover">`.
    let cover_path = [
        doc.get_cover_id(),
        doc.mdata("cover").map(|m| m.value.clone()),
    ]
    .into_iter()
    .flatten()
    .find_map(|id| doc.resources.get(&id))?
    .path
    .to_str()?
    .to_string();

    let mut archive = zip::ZipArchive::new(File::open(path).ok()?).ok()?;
    let name = if archive.index_for_name(&cover_path).is_some() {
        cover_path
    } else {
        percent_encoding::percent_decode_str(&cover_path)
            .decode_utf8()
            .ok()?
            .into_owned()
    };
    let entry = archive.by_name(&name).ok()?;
    if entry.size() > MAX_COVER_BYTES {
        return None;
    }
    // Declared sizes can lie; never read more than the cap allows.
    let mut data = Vec::new();
    entry
        .take(MAX_COVER_BYTES + 1)
        .read_to_end(&mut data)
        .ok()?;
    (!data.is_empty() && data.len() as u64 <= MAX_COVER_BYTES).then_some(data)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    use super::*;

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
                format: MIMETYPE::EPUB,
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
    }
}
