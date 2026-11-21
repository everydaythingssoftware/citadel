//! Generated package documents never panic or overflow the stack, and every
//! result stays within the limits.
use citadel_epub::fixtures as support;

use std::{fmt::Write as _, io::Cursor};

use citadel_epub::{limits, EpubError, Refusal};
use proptest::prelude::*;

#[derive(Clone, Debug)]
struct Shape {
    depth: usize,
    attributes: usize,
    namespaces: usize,
    subjects: usize,
    value_bytes: usize,
    padding: usize,
}

fn shapes() -> impl Strategy<Value = Shape> {
    (
        prop_oneof![0..300usize, 0..100_000usize],
        0..200usize,
        0..400usize,
        prop_oneof![0..10usize, 4_000..4_200usize],
        prop_oneof![0..100usize, 60_000..70_000usize],
        prop_oneof![0..10usize, 8_380_000..8_400_000usize],
    )
        .prop_map(
            |(depth, attributes, namespaces, subjects, value_bytes, padding)| Shape {
                depth,
                attributes,
                namespaces,
                subjects,
                value_bytes,
                padding,
            },
        )
}

fn document(shape: &Shape) -> String {
    let mut text = String::from(
        r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/""#,
    );
    for n in 0..shape.namespaces {
        let _ = write!(text, r#" xmlns:n{n}="urn:n:{n}""#);
    }
    text.push('>');
    text.push_str("<dc:title");
    for n in 0..shape.attributes {
        let _ = write!(text, r#" a{n}="v""#);
    }
    text.push('>');
    text.push_str(&"t".repeat(shape.value_bytes));
    text.push_str("</dc:title>");
    text.push_str(&"<dc:subject>s</dc:subject>".repeat(shape.subjects));
    text.push_str(&"<x>".repeat(shape.depth));
    text.push_str(&"</x>".repeat(shape.depth));
    text.push_str(&" ".repeat(shape.padding));
    text.push_str("</metadata><manifest/><spine/></package>");
    text
}

/// Whether `shape` breaks a limit the reader must refuse at.
fn breaks_a_limit(shape: &Shape, bytes: usize) -> bool {
    bytes as u64 > limits::MAX_PACKAGE_BYTES
        || shape.depth + 2 > limits::MAX_DEPTH
        || shape.attributes > limits::MAX_ATTRIBUTES
        || shape.namespaces + 1 > limits::MAX_ATTRIBUTES
        || shape.namespaces + 1 > limits::MAX_NAMESPACE_BINDINGS
        || shape.subjects + 1 > limits::MAX_METADATA_ITEMS
        || shape.value_bytes > limits::MAX_VALUE_BYTES
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 48, ..ProptestConfig::default() })]

    #[test]
    fn generated_packages_are_read_or_refused(shape in shapes()) {
        let text = document(&shape);
        let size = text.len();
        let bytes = support::Builder::with_package(text).build();
        let result = std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(move || citadel_epub::read(Cursor::new(bytes)))
            .unwrap()
            .join()
            .expect("reading never panics");
        let limit_broken = breaks_a_limit(&shape, size);
        match result {
            Ok(package) => {
                prop_assert!(!limit_broken, "read despite breaking a limit: {shape:?}");
                prop_assert!(package.subjects.len() <= limits::MAX_METADATA_ITEMS);
                prop_assert!(package.title.map_or(0, |t| t.len()) <= limits::MAX_VALUE_BYTES);
            }
            Err(EpubError::Refused(refusal)) => {
                prop_assert!(limit_broken, "refused within the limits: {refusal:?} {shape:?}");
                prop_assert!(!matches!(refusal, Refusal::InvalidRootfile | Refusal::NoRootfile));
            }
            Err(error) => prop_assert!(false, "unexpected {error:?} for {shape:?}"),
        }
    }

    #[test]
    fn arbitrary_bytes_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..4096)) {
        let _ = citadel_epub::read(Cursor::new(bytes));
    }

    #[test]
    fn damaged_archives_never_panic(position in 0usize..4096, value in any::<u8>()) {
        let mut bytes = support::Builder::book(support::METADATA, "").build();
        let at = position % bytes.len();
        bytes[at] = value;
        let _ = citadel_epub::read(Cursor::new(bytes));
    }
}
