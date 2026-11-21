//! Well-formed books read as EPUB 3.3 and Readium's metadata mapping say.
use citadel_epub::fixtures as support;

use std::io::Cursor;

use citadel_epub::{Contributor, Epub, EpubError, Package, Refusal, Unreadable};
use support::{package, Builder, METADATA};

fn read(bytes: Vec<u8>) -> Package {
    citadel_epub::read(Cursor::new(bytes)).unwrap()
}

fn cover(bytes: Vec<u8>) -> Option<Vec<u8>> {
    Epub::open(Cursor::new(bytes)).unwrap().cover(1024).unwrap()
}

fn person(name: &str, sort_as: Option<&str>, roles: &[&str]) -> Contributor {
    Contributor {
        name: name.into(),
        sort_as: sort_as.map(Into::into),
        roles: roles.iter().map(|role| role.to_string()).collect(),
    }
}

#[test]
fn epub3_refinements_name_the_title_and_creators() {
    let package = read(
        Builder::book(
            r##"<dc:identifier id="id">urn:uuid:1</dc:identifier>
            <dc:title id="sub">A Subtitle</dc:title>
            <dc:title id="main">The Main Title</dc:title>
            <meta refines="#main" property="title-type">main</meta>
            <meta refines="#sub" property="title-type">subtitle</meta>
            <meta refines="#main" property="file-as">Main Title, The</meta>
            <dc:creator id="c1">Ursula K. Le Guin</dc:creator>
            <meta refines="#c1" property="file-as">Le Guin, Ursula K.</meta>
            <meta refines="#c1" property="role" scheme="marc:relators">aut</meta>
            <dc:creator id="c2">Ann Translator</dc:creator>
            <meta refines="#c2" property="role" scheme="marc:relators">trl</meta>
            <dc:creator>Someone</dc:creator>
            <dc:contributor id="k">Co Author</dc:contributor>
            <meta refines="#k" property="role" scheme="marc:relators">aut</meta>
            <dc:contributor>Just Helped</dc:contributor>
            <dc:date>2019-04-02</dc:date>
            <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>"##,
            "",
        )
        .build(),
    );
    assert_eq!(package.title.as_deref(), Some("The Main Title"));
    assert_eq!(package.title_sort.as_deref(), Some("Main Title, The"));
    assert_eq!(
        package.creators,
        vec![
            person("Ursula K. Le Guin", Some("Le Guin, Ursula K."), &["aut"]),
            person("Ann Translator", None, &["trl"]),
            person("Someone", None, &[]),
        ]
    );
    let authors: Vec<&str> = package.authors().map(|a| a.name.as_str()).collect();
    assert_eq!(authors, ["Ursula K. Le Guin", "Someone", "Co Author"]);
    assert_eq!(package.published.as_deref(), Some("2019-04-02"));
}

#[test]
fn epub2_attributes_give_file_as_role_and_publication_date() {
    let package = read(
        Builder::with_package(package(
            "2.0",
            r#"<dc:identifier id="id" opf:scheme="ISBN">9780140449136</dc:identifier>
            <dc:title>The Odyssey</dc:title>
            <dc:creator opf:role="aut" opf:file-as="Homer">Homer</dc:creator>
            <dc:creator opf:role="trl" opf:file-as="Wilson, Emily">Emily Wilson</dc:creator>
            <dc:date opf:event="modification">2020-01-01</dc:date>
            <dc:date opf:event="publication">2018-11-06</dc:date>
            <meta name="calibre:title_sort" content="Odyssey, The"/>"#,
            "",
        ))
        .build(),
    );
    assert_eq!(package.version.as_deref(), Some("2.0"));
    assert_eq!(package.title_sort.as_deref(), Some("Odyssey, The"));
    assert_eq!(
        package.creators,
        vec![
            person("Homer", Some("Homer"), &["aut"]),
            person("Emily Wilson", Some("Wilson, Emily"), &["trl"]),
        ]
    );
    assert_eq!(package.authors().count(), 1);
    assert_eq!(package.published.as_deref(), Some("2018-11-06"));
}

#[test]
fn the_unique_identifier_is_the_identifier() {
    let package = read(
        Builder::book(
            r#"<dc:identifier id="uuid">urn:uuid:ffff</dc:identifier><dc:identifier id="id">urn:isbn:9780140449136</dc:identifier><dc:title>T</dc:title>"#,
            "",
        )
        .build(),
    );
    assert_eq!(
        package.identifier.as_deref(),
        Some("urn:isbn:9780140449136")
    );
    assert_eq!(
        package.identifiers,
        ["urn:uuid:ffff", "urn:isbn:9780140449136"]
    );

    let unnamed = read(
        Builder::book(
            r#"<dc:identifier>first</dc:identifier><dc:identifier>second</dc:identifier>"#,
            "",
        )
        .build(),
    );
    assert_eq!(unnamed.identifier.as_deref(), Some("first"));
}

#[test]
fn covers_come_from_the_cover_image_property_or_the_epub2_meta() {
    let epub3 = Builder::with_package(package(
        "3.3",
        METADATA,
        r#"<item id="c" href="images/c%20over.png" media-type="image/png" properties="svg cover-image"/>"#,
    ))
    .entry("OEBPS/images/c over.png", "png bytes")
    .build();
    assert_eq!(
        read(epub3.clone()).cover.unwrap().path,
        "OEBPS/images/c over.png"
    );
    assert_eq!(cover(epub3).unwrap(), b"png bytes");

    let epub2 = Builder::with_package(package(
        "2.0",
        &format!(r#"{METADATA}<meta name="cover" content="cover-id"/>"#),
        r#"<item id="cover-id" href="../cover.jpg" media-type="image/jpeg"/>"#,
    ))
    .entry("cover.jpg", "jpeg bytes")
    .build();
    assert_eq!(cover(epub2).unwrap(), b"jpeg bytes");

    let both = Builder::with_package(package(
        "3.0",
        &format!(r#"{METADATA}<meta name="cover" content="old"/>"#),
        r#"<item id="old" href="old.jpg" media-type="image/jpeg"/><item id="new" href="new.jpg" media-type="image/jpeg" properties="cover-image"/>"#,
    ))
    .entry("OEBPS/old.jpg", "old")
    .entry("OEBPS/new.jpg", "new")
    .build();
    assert_eq!(cover(both).unwrap(), b"new");

    let oversized = Builder::book(
        METADATA,
        r#"<item id="c" href="c.png" media-type="image/png" properties="cover-image"/>"#,
    )
    .entry("OEBPS/c.png", vec![1; 2048])
    .build();
    assert_eq!(cover(oversized), None);
}

#[test]
fn a_package_at_the_archive_root_is_read() {
    let bytes = Builder::empty()
        .entry("META-INF/container.xml", support::container("content.opf"))
        .entry(
            "content.opf",
            package("3.0", METADATA, r#"<item id="c" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>"#),
        )
        .entry("cover.jpg", "root cover")
        .build();
    assert_eq!(read(bytes.clone()).path, "content.opf");
    assert_eq!(cover(bytes).unwrap(), b"root cover");
}

#[test]
fn dublin_core_is_found_by_namespace_not_prefix() {
    let bytes = Builder::with_package(
        r#"<?xml version="1.0"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><opf:metadata xmlns:dcterms="http://purl.org/dc/elements/1.1/"><dcterms:identifier id="id">x</dcterms:identifier><dcterms:title>Prefixed</dcterms:title><title xmlns="http://purl.org/dc/elements/1.1/">Ignored second</title><other:title xmlns:other="urn:not-dc">Not DC</other:title></opf:metadata><opf:manifest/><opf:spine/></opf:package>"#,
    )
    .build();
    let package = read(bytes);
    assert_eq!(package.title.as_deref(), Some("Prefixed"));
    assert_eq!(package.identifier.as_deref(), Some("x"));
}

#[test]
fn utf16_and_byte_order_marks_are_decoded() {
    let document = package("3.0", "<dc:title>Ünïcødé — 書</dc:title>", "")
        .replace(r#"encoding="UTF-8""#, r#"encoding="UTF-16""#);
    let mut utf16le = vec![0xFF, 0xFE];
    utf16le.extend(document.encode_utf16().flat_map(u16::to_le_bytes));
    let mut utf16be = vec![0xFE, 0xFF];
    utf16be.extend(document.encode_utf16().flat_map(u16::to_be_bytes));
    let no_bom: Vec<u8> = document.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut utf8_bom = vec![0xEF, 0xBB, 0xBF];
    utf8_bom.extend(package("3.0", "<dc:title>Ünïcødé — 書</dc:title>", "").into_bytes());
    for bytes in [utf16le, utf16be, no_bom, utf8_bom] {
        assert_eq!(
            read(Builder::with_package(bytes).build()).title.as_deref(),
            Some("Ünïcødé — 書")
        );
    }

    let latin1 = package("3.0", "<dc:title>Caf\u{e9}</dc:title>", "")
        .replace(r#"encoding="UTF-8""#, r#"encoding="ISO-8859-1""#);
    let (encoded, _, _) = encoding_rs::WINDOWS_1252.encode(&latin1);
    assert_eq!(
        read(Builder::with_package(encoded.into_owned()).build())
            .title
            .as_deref(),
        Some("Café")
    );
}

#[test]
fn cdata_comments_and_character_references_are_text() {
    let package = read(
        Builder::book(
            r#"<dc:title><![CDATA[Fish & <Chips>]]> &amp; Peas&#x21;<!-- note --></dc:title><dc:description><p xmlns="http://www.w3.org/1999/xhtml">Nested <b>markup</b></p></dc:description>"#,
            "",
        )
        .build(),
    );
    assert_eq!(package.title.as_deref(), Some("Fish & <Chips> & Peas!"));
    assert_eq!(package.description.as_deref(), Some("Nested markup"));
}

#[test]
fn the_first_package_rootfile_is_read() {
    let container = r#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="other.pdf" media-type="application/pdf"/><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/><rootfile full-path="second.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;
    let bytes = Builder::empty()
        .entry("META-INF/container.xml", container)
        .entry(
            "OEBPS/content.opf",
            package("3.0", "<dc:title>First</dc:title>", ""),
        )
        .entry(
            "second.opf",
            package("3.0", "<dc:title>Second</dc:title>", ""),
        )
        .build();
    assert_eq!(read(bytes).title.as_deref(), Some("First"));
}

#[test]
fn damaged_books_are_unreadable_not_refused() {
    let unreadable = |bytes: Vec<u8>| match citadel_epub::read(Cursor::new(bytes)) {
        Err(EpubError::Unreadable(reason)) => reason,
        other => panic!("{other:?}"),
    };
    assert_eq!(unreadable(b"not a zip".to_vec()), Unreadable::NotAZip);
    assert_eq!(
        unreadable(Builder::empty().build()),
        Unreadable::MissingContainer
    );
    assert_eq!(
        unreadable(
            Builder::empty()
                .entry("META-INF/container.xml", support::container("gone.opf"))
                .build()
        ),
        Unreadable::MissingPackage
    );
    assert!(matches!(
        unreadable(Builder::with_package("<package><metadata>").build()),
        Unreadable::Malformed(_)
    ));
    assert_eq!(
        unreadable(
            Builder::with_package(
                r#"<package xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest/></package>"#
            )
            .build()
        ),
        Unreadable::MissingSpine
    );
    assert!(matches!(
        unreadable(Builder::book("<dc:title>&nbsp;</dc:title>", "").build()),
        Unreadable::Malformed(_)
    ));
    assert!(matches!(
        citadel_epub::read(Cursor::new(
            Builder::empty()
                .entry("META-INF/container.xml", r#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles/></container>"#)
                .build()
        )),
        Err(EpubError::Refused(Refusal::NoRootfile))
    ));
}

#[test]
fn prepended_data_is_tolerated() {
    let mut bytes = b"junk before the archive".to_vec();
    bytes.extend(Builder::book(METADATA, "").build());
    assert_eq!(read(bytes).title.as_deref(), Some("A Hostile Book"));
}

#[test]
fn limits_are_inclusive() {
    // `package` and `metadata` are two of the 256 levels.
    assert!(citadel_epub::read(Cursor::new(support::nested_package(254).build())).is_ok());
    assert!(matches!(
        citadel_epub::read(Cursor::new(support::nested_package(255).build())),
        Err(EpubError::Refused(Refusal::TooDeep { .. }))
    ));
}

/// Zips a W3C test-suite fixture (see `tests/fixtures/w3c/LICENSE`).
fn w3c(name: &str) -> Vec<u8> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/w3c")
        .join(name);
    let mut builder = Builder::empty();
    let mut pending = vec![root.clone()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else {
                let name = path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                builder = builder.entry(&name, std::fs::read(&path).unwrap());
            }
        }
    }
    builder.build()
}

#[test]
fn w3c_reading_system_tests_pass() {
    let creators = read(w3c("pkg-creator-order"));
    let names: Vec<&str> = creators
        .authors()
        .map(|creator| creator.name.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "Dave Cramer",
            "Wendy Reid",
            "Dan Lazin",
            "Ivan Herman",
            "Brady Duga"
        ]
    );
    assert_eq!(creators.identifier.as_deref(), Some("pkg-creator-order"));

    assert_eq!(
        read(w3c("pkg-title-order")).title.as_deref(),
        Some("pkg-title-order")
    );

    let whitespace = read(w3c("pkg-meta-whitespace"));
    assert_eq!(whitespace.creators[0].name, "Dave Cramer");

    assert_eq!(
        read(w3c("ocf-package_multiple")).path,
        "FOO/BAR/package.opf"
    );
}
