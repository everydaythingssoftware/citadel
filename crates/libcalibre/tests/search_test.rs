// Tests for Library search and author lookup
// This binary uses only a subset of the shared test helpers.
#[allow(dead_code, unused_imports)]
mod common;

use common::setup_with_library;
use libcalibre::{BookAdd, BookQuery, BookUpdate, Library};
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

/// The titles that `search_books` finds for `text`, sorted.
fn search_titles(lib: &mut Library, text: &str) -> Vec<String> {
    let mut titles: Vec<String> = lib
        .search_books(text)
        .unwrap()
        .into_iter()
        .map(|book| book.title)
        .collect();
    titles.sort();
    titles
}

fn add_titles(lib: &mut Library, titles: &[&str]) {
    for title in titles {
        lib.add_book(book_with_authors(title, &[])).unwrap();
    }
}

#[test]
fn test_search_cyrillic_title_ignores_case() {
    let (_temp, mut lib) = setup_with_library();
    add_titles(&mut lib, &["Война и мир", "Анна Каренина"]);

    assert_eq!(search_titles(&mut lib, "война"), ["Война и мир"]);
}

#[test]
fn test_search_cyrillic_author_and_series_ignore_case() {
    let (_temp, mut lib) = setup_with_library();
    lib.add_book(BookAdd {
        series: Some("Сказки".to_string()),
        series_index: Some(1.0),
        ..book_with_authors("Детство", &["Лев Толстой"])
    })
    .unwrap();
    add_titles(&mut lib, &["Unrelated Book"]);

    assert_eq!(search_titles(&mut lib, "толстой"), ["Детство"]);
    assert_eq!(search_titles(&mut lib, "сказки"), ["Детство"]);
}

#[test]
fn test_search_greek_ignores_case_and_final_sigma() {
    let (_temp, mut lib) = setup_with_library();
    add_titles(&mut lib, &["ΟΔΥΣΣΕΎΣ", "Unrelated Book"]);

    // The final sigma "ς" folds to "σ", the same as the capital "Σ".
    assert_eq!(search_titles(&mut lib, "οδυσσεύς"), ["ΟΔΥΣΣΕΎΣ"]);
}

#[test]
fn test_search_uppercase_query_finds_lowercase_title() {
    let (_temp, mut lib) = setup_with_library();
    add_titles(&mut lib, &["мой толстой", "Unrelated Book"]);

    assert_eq!(search_titles(&mut lib, "ТОЛСТОЙ"), ["мой толстой"]);
}

#[test]
fn test_search_yo_matches_ye() {
    let (_temp, mut lib) = setup_with_library();
    add_titles(&mut lib, &["Всё", "Все", "Другое"]);

    assert_eq!(search_titles(&mut lib, "всё"), ["Все", "Всё"]);
    assert_eq!(search_titles(&mut lib, "все"), ["Все", "Всё"]);
}

#[test]
fn test_search_nfc_query_finds_nfd_title() {
    let (_temp, mut lib) = setup_with_library();
    add_titles(&mut lib, &["Rene\u{0301}e", "Unrelated Book"]);

    assert_eq!(search_titles(&mut lib, "Ren\u{00E9}e"), ["Rene\u{0301}e"]);
}

#[test]
fn test_search_matches_any_combining_mark_order() {
    let (_temp, mut lib) = setup_with_library();
    add_titles(&mut lib, &["Vi\u{1EC7}t Nam", "Unrelated Book"]);

    // U+0302 before U+0323 is not the canonical order, which puts U+0323
    // (dot below) first. NFC reorders the marks.
    assert_eq!(
        search_titles(&mut lib, "vie\u{0302}\u{0323}t"),
        ["Vi\u{1EC7}t Nam"]
    );
}

#[test]
fn test_search_keeps_accents_significant() {
    let (_temp, mut lib) = setup_with_library();
    add_titles(&mut lib, &["García Márquez"]);

    assert!(search_titles(&mut lib, "garcia").is_empty());
    assert_eq!(search_titles(&mut lib, "garcía"), ["García Márquez"]);
}

#[test]
fn test_search_sharp_s_matches_ss() {
    let (_temp, mut lib) = setup_with_library();
    add_titles(&mut lib, &["STRASSE", "Straße", "Unrelated Book"]);

    assert_eq!(search_titles(&mut lib, "straße"), ["STRASSE", "Straße"]);
    assert_eq!(search_titles(&mut lib, "strasse"), ["STRASSE", "Straße"]);
}

#[test]
fn test_search_escapes_wildcards_in_non_ascii_text() {
    let (_temp, mut lib) = setup_with_library();
    add_titles(&mut lib, &["100% Правда", "1000 Правда"]);

    assert_eq!(search_titles(&mut lib, "100% правда"), ["100% Правда"]);
}

#[test]
fn test_query_books_total_matches_items_for_non_ascii() {
    let (_temp, mut lib) = setup_with_library();
    add_titles(
        &mut lib,
        &[
            "Война и мир",
            "мой толстой",
            "Всё",
            "Все",
            "STRASSE",
            "Straße",
            "100% Правда",
            "1000 Правда",
        ],
    );

    for text in ["война", "ТОЛСТОЙ", "всё", "straße", "100% правда"] {
        let page = lib
            .query_books(BookQuery {
                text: Some(text.to_string()),
                ..BookQuery::default()
            })
            .unwrap();
        assert!(page.total > 0, "{text} must match a book");
        assert_eq!(page.items.len() as u64, page.total, "{text}");
    }
}

#[test]
fn test_schema_never_refers_to_casefold() {
    let (_temp, mut lib) = setup_with_library();
    let book = lib
        .add_book(BookAdd {
            tags: Some(vec!["Фэнтези".to_string()]),
            ..book_with_authors("Война и мир", &["Лев Толстой"])
        })
        .unwrap();
    assert_eq!(search_titles(&mut lib, "война"), ["Война и мир"]);
    lib.update_book(
        book.id,
        BookUpdate {
            tags: Some(vec!["фэнтези".to_string(), "Сказки".to_string()]),
            ..BookUpdate::default()
        },
    )
    .unwrap();

    let conn = rusqlite::Connection::open(lib.database_path()).unwrap();
    let references: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE sql LIKE '%casefold%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(references, 0);
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
