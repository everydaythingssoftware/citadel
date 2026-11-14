// Tests for Library search and author lookup
// This binary uses only a subset of the shared test helpers.
#[allow(dead_code, unused_imports)]
mod common;

use common::setup_with_library;
use libcalibre::BookAdd;
use std::collections::HashMap;

fn book_with_authors(title: &str, author_names: &[&str]) -> BookAdd {
    BookAdd {
        title: title.to_string(),
        author_names: author_names.iter().map(|n| (*n).to_string()).collect(),
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

#[test]
fn test_search_title_substring_case_insensitive() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_book(book_with_authors("The Rust Programming Language", &[]))
        .unwrap();
    lib.add_book(book_with_authors("Cooking for Two", &[]))
        .unwrap();

    let results = lib.search_books("rust").unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].title, "The Rust Programming Language");
}

#[test]
fn test_search_author_name() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_book(book_with_authors("Pride and Prejudice", &["Jane Austen"]))
        .unwrap();
    lib.add_book(book_with_authors("Moby Dick", &["Herman Melville"]))
        .unwrap();

    let results = lib.search_books("austen").unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].title, "Pride and Prejudice");
}

#[test]
fn test_search_series_name() {
    let (_temp, mut lib) = setup_with_library();

    let in_series = lib
        .add_book(BookAdd {
            series: Some("The Lord of the Rings".to_string()),
            series_index: Some(1.0),
            ..book_with_authors("The Fellowship of the Ring", &[])
        })
        .unwrap();
    lib.add_book(book_with_authors("Unrelated Book", &[]))
        .unwrap();

    let results = lib.search_books("lord of the rings").unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, in_series.id);
}

#[test]
fn test_search_no_match_returns_empty() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_book(book_with_authors("Book One", &["Author One"]))
        .unwrap();
    lib.add_book(book_with_authors("Book Two", &["Author Two"]))
        .unwrap();

    let results = lib.search_books("xyzzy").unwrap();
    assert!(results.is_empty());
}

#[test]
fn test_search_escapes_like_wildcards() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_book(book_with_authors("100% Done", &[])).unwrap();
    lib.add_book(book_with_authors("Another Book", &[]))
        .unwrap();

    let results = lib.search_books("100%").unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].title, "100% Done");

    let results = lib.search_books("z%y").unwrap();
    assert!(results.is_empty());

    let results = lib.search_books("0% D").unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].title, "100% Done");
}

#[test]
fn test_search_empty_or_whitespace_query_returns_empty() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_book(book_with_authors("Book One", &[])).unwrap();

    assert!(lib.search_books("").unwrap().is_empty());
    assert!(lib.search_books("   \t\n").unwrap().is_empty());
}

#[test]
fn test_find_by_author() {
    let (_temp, mut lib) = setup_with_library();

    let first = lib
        .add_book(book_with_authors("Emma", &["Jane Austen"]))
        .unwrap();
    let second = lib
        .add_book(book_with_authors("Persuasion", &["Jane Austen"]))
        .unwrap();
    lib.add_book(book_with_authors("Moby Dick", &["Herman Melville"]))
        .unwrap();

    let austen_id = first.authors[0].id;
    assert_eq!(second.authors[0].id, austen_id);

    let mut results = lib.find_by_author(austen_id).unwrap();
    results.sort_by_key(|b| b.id.as_i32());

    assert_eq!(results.len(), 2);
    assert_eq!(results[0].title, "Emma");
    assert_eq!(results[1].title, "Persuasion");
    for book in &results {
        assert_eq!(book.authors.len(), 1);
        assert_eq!(book.authors[0].name, "Jane Austen");
    }
}
