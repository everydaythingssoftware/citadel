// Tests for the lean cover-source reads that back cover-thumbnail generation.
mod common;

use common::setup_with_library;
use libcalibre::{BookAdd, BookId};
use std::collections::HashMap;

fn empty_book(title: &str) -> BookAdd {
    BookAdd {
        title: title.to_string(),
        author_names: vec![],
        tags: None,
        series: None,
        series_index: None,
        publisher: None,
        publication_date: None,
        rating: None,
        description: None,
        identifiers: HashMap::new(),
        language: None,
        file_paths: vec![],
    }
}

/// A 1x1 JPEG, enough for `set_book_cover` to flip `has_cover` to true.
const TINY_JPEG: &[u8] = &[
    0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0x03, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03, 0x02, 0x02,
    0x02, 0x03, 0x03, 0x03, 0x03, 0x04, 0x06, 0x04, 0x04, 0x04, 0x04, 0x04, 0x08, 0x06, 0x06, 0x05,
    0x06, 0x09, 0x08, 0x0A, 0x0A, 0x09, 0x08, 0x09, 0x09, 0x0A, 0x0C, 0x0F, 0x0C, 0x0A, 0x0B, 0x0E,
    0x0B, 0x09, 0x09, 0x0D, 0x11, 0x0D, 0x0E, 0x0F, 0x10, 0x10, 0x11, 0x10, 0x0A, 0x0C, 0x12, 0x13,
    0x12, 0x10, 0x13, 0x0F, 0x10, 0x10, 0x10, 0xFF, 0xC9, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01,
    0x01, 0x01, 0x11, 0x00, 0xFF, 0xCC, 0x00, 0x06, 0x00, 0x10, 0x10, 0x05, 0xFF, 0xDA, 0x00, 0x08,
    0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xD2, 0xCF, 0x20, 0xFF, 0xD9,
];

#[test]
fn cover_sources_returns_only_covered_books_id_and_path() {
    let (_temp, mut lib) = setup_with_library();

    let covered = lib.add_book(empty_book("Has Cover")).unwrap();
    let _uncovered = lib.add_book(empty_book("No Cover")).unwrap();

    // Before any cover is set, nothing qualifies.
    assert!(lib.cover_sources().unwrap().is_empty());

    lib.set_book_cover(covered.id, TINY_JPEG.to_vec()).unwrap();

    let sources = lib.cover_sources().unwrap();
    assert_eq!(sources.len(), 1);
    let (id, path) = &sources[0];
    assert_eq!(*id, covered.id);
    // The path is the book's folder relative to the library root, matching
    // the hydrated `book_dir_path`.
    let hydrated = lib.get_book(covered.id).unwrap();
    assert_eq!(*path, hydrated.book_dir_path);
}

#[test]
fn cover_sources_for_filters_to_requested_covered_ids() {
    let (_temp, mut lib) = setup_with_library();

    let a = lib.add_book(empty_book("A")).unwrap();
    let b = lib.add_book(empty_book("B")).unwrap();
    let c = lib.add_book(empty_book("C")).unwrap();

    lib.set_book_cover(a.id, TINY_JPEG.to_vec()).unwrap();
    lib.set_book_cover(b.id, TINY_JPEG.to_vec()).unwrap();
    // c has no cover.

    // Ask for a (covered), c (no cover), and a nonexistent id.
    let requested = [a.id, c.id, BookId::from(9999)];
    let sources = lib.cover_sources_for(&requested).unwrap();

    let ids: Vec<BookId> = sources.iter().map(|(id, _)| *id).collect();
    assert_eq!(ids, vec![a.id]);

    // b is covered but was not requested, so it must be absent.
    assert!(!ids.contains(&b.id));
}

#[test]
fn cover_sources_for_empty_input_returns_empty() {
    let (_temp, mut lib) = setup_with_library();
    let book = lib.add_book(empty_book("X")).unwrap();
    lib.set_book_cover(book.id, TINY_JPEG.to_vec()).unwrap();

    assert!(lib.cover_sources_for(&[]).unwrap().is_empty());
}
