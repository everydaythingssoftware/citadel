// Tests for Library search and author lookup
// This binary uses only a subset of the shared test helpers.
#[allow(dead_code, unused_imports)]
mod common;

use common::setup_with_library;
use diesel::sql_types::Integer;
use diesel::{sql_query, RunQueryDsl};
use libcalibre::{
    BookAdd, BookPage, BookQuery, BookSortOrder, CalibreError, CustomValueFilter, Library,
    SearchError, SearchScope, Spanned,
};
use std::collections::HashMap;
use tempfile::TempDir;

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
    lib.add_book(book_with_authors("100 Days", &[])).unwrap();

    let results = lib.search_books("100%").unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].title, "100% Done");

    let results = lib.search_books("z%y").unwrap();
    assert!(results.is_empty());

    let results = lib.search_books("\"0% D\"").unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].title, "100% Done");

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

/// Build a library with five books that the field search tests share.
fn fixture() -> (TempDir, Library) {
    let (temp, mut lib) = setup_with_library();
    let epub = temp.path().join("hobbit.epub");
    std::fs::write(&epub, b"epub").unwrap();

    lib.add_book(BookAdd {
        tags: Some(vec!["Fantasy".to_string(), "Classic".to_string()]),
        series: Some("Middle-earth".to_string()),
        series_index: Some(1.0),
        publisher: Some("Allen & Unwin".to_string()),
        description: Some("A dragon guards treasure.".to_string()),
        identifiers: HashMap::from([("isbn".to_string(), "9780547928227".to_string())]),
        language: Some("en".to_string()),
        file_paths: vec![epub],
        ..book_with_authors("The Hobbit", &["J. R. R. Tolkien"])
    })
    .unwrap();
    lib.add_book(BookAdd {
        tags: Some(vec!["Science Fiction".to_string()]),
        publisher: Some("Chilton".to_string()),
        identifiers: HashMap::from([("goodreads".to_string(), "234225".to_string())]),
        language: Some("en".to_string()),
        ..book_with_authors("Dune", &["Frank Herbert"])
    })
    .unwrap();
    lib.add_book(BookAdd {
        tags: Some(vec!["Light Novel".to_string()]),
        language: Some("ja".to_string()),
        ..book_with_authors("Re:Zero", &["Tappei Nagatsuki"])
    })
    .unwrap();
    lib.add_book(book_with_authors("O'Brien Stories", &["Flann O'Brien"]))
        .unwrap();
    lib.add_book(BookAdd {
        language: Some("es".to_string()),
        ..book_with_authors("Cien años de soledad", &["Gabriel García Márquez"])
    })
    .unwrap();
    (temp, lib)
}

/// A query for `text`, sorted by title, with no limit.
fn text_query(text: &str) -> BookQuery {
    BookQuery {
        text: Some(text.to_string()),
        sort: BookSortOrder::TitleAsc,
        limit: None,
        ..BookQuery::default()
    }
}

/// The scope of the "All Fields" menu item.
const ALL: SearchScope = SearchScope::AllFields;

/// The default scope.
const DEFAULT: SearchScope = SearchScope::TitlesAuthorsSeries;

/// The result of `text` in the given scope.
fn page(lib: &mut Library, text: &str, scope: SearchScope) -> Result<BookPage, CalibreError> {
    lib.query_books(BookQuery {
        search_scope: scope,
        ..text_query(text)
    })
}

/// The titles that `text` finds, sorted by title.
fn titles(lib: &mut Library, text: &str, scope: SearchScope) -> Vec<String> {
    page(lib, text, scope)
        .unwrap()
        .items
        .into_iter()
        .map(|book| book.title)
        .collect()
}

/// The hint messages that `text` gives.
fn hints(lib: &mut Library, text: &str, scope: SearchScope) -> Vec<String> {
    page(lib, text, scope)
        .unwrap()
        .hints
        .iter()
        .map(ToString::to_string)
        .collect()
}

/// The hint of the misspelled field `titel`.
const TITEL_HINT: &str = r#"No field named "titel". Searched as text."#;

/// The hint messages of a page.
fn hint_messages(page: &BookPage) -> Vec<String> {
    page.hints.iter().map(ToString::to_string).collect()
}

/// The titles of a page, in the sequence of the page.
fn page_titles(page: &BookPage) -> Vec<&str> {
    page.items.iter().map(|book| book.title.as_str()).collect()
}

/// The search error that `text` gives.
fn error(lib: &mut Library, text: &str, scope: SearchScope) -> SearchError {
    match page(lib, text, scope) {
        Err(CalibreError::InvalidSearch(error)) => error.value,
        other => panic!("expected InvalidSearch, got {other:?}"),
    }
}

#[test]
fn bare_words_reach_tags_publisher_and_identifiers() {
    let (_temp, mut lib) = fixture();
    assert_eq!(titles(&mut lib, "fantasy", ALL), ["The Hobbit"]);
    assert_eq!(titles(&mut lib, "chilton", ALL), ["Dune"]);
    assert_eq!(titles(&mut lib, "9780547928227", ALL), ["The Hobbit"]);
    assert!(titles(&mut lib, "dragon", ALL).is_empty());
    assert_eq!(titles(&mut lib, "tolkien hobbit", ALL), ["The Hobbit"]);
    assert!(titles(&mut lib, "tolkien dune", ALL).is_empty());
}

#[test]
fn fields_match_contains_equality_and_presence() {
    let (_temp, mut lib) = fixture();
    assert_eq!(titles(&mut lib, "tags:fiction", ALL), ["Dune"]);
    assert!(titles(&mut lib, "tags:=fiction", ALL).is_empty());
    assert_eq!(titles(&mut lib, "tags:\"=science fiction\"", ALL), ["Dune"]);
    assert_eq!(
        titles(&mut lib, "tags:false", ALL),
        ["Cien años de soledad", "O'Brien Stories"]
    );
    assert_eq!(titles(&mut lib, "comments:dragon", ALL), ["The Hobbit"]);
    assert_eq!(titles(&mut lib, "formats:epub", ALL), ["The Hobbit"]);
    assert_eq!(
        titles(&mut lib, "languages:eng", ALL),
        ["Dune", "The Hobbit"]
    );
    assert_eq!(
        titles(&mut lib, "publisher:true", ALL),
        ["Dune", "The Hobbit"]
    );
    assert_eq!(titles(&mut lib, "series:middle", ALL), ["The Hobbit"]);
    assert_eq!(
        titles(&mut lib, "authors:\"=frank herbert\"", ALL),
        ["Dune"]
    );
    assert_eq!(titles(&mut lib, "title:true", ALL).len(), 5);
}

#[test]
fn field_terms_follow_the_table() {
    let (_temp, mut lib) = fixture();
    let cases: Vec<(&str, Vec<&str>)> = vec![
        ("title:=\"the hobbit\"", vec!["The Hobbit"]),
        ("title:=hobbit", vec![]),
        ("series:=middle-earth", vec!["The Hobbit"]),
        ("series:=middle", vec![]),
        ("publisher:=chilton", vec!["Dune"]),
        ("publisher:=chil", vec![]),
        ("publisher:allen", vec!["The Hobbit"]),
        (
            "comments:=\"a dragon guards treasure.\"",
            vec!["The Hobbit"],
        ),
        ("comments:=dragon", vec![]),
        ("formats:=epub", vec!["The Hobbit"]),
        ("formats:=pub", vec![]),
        ("languages:=eng", vec!["Dune", "The Hobbit"]),
        ("languages:=en", vec![]),
        (
            "not (tags:fantasy or tags:fiction)",
            vec!["Cien años de soledad", "O'Brien Stories", "Re:Zero"],
        ),
        ("identifiers:isbn:978", vec!["The Hobbit"]),
        ("identifiers:good:234", vec!["Dune"]),
        ("identifiers:=234225", vec!["Dune"]),
        ("title:false", vec![]),
        ("tags:true", vec!["Dune", "The Hobbit", "Re:Zero"]),
        (
            "publisher:false",
            vec!["Cien años de soledad", "O'Brien Stories", "Re:Zero"],
        ),
        ("title:%", vec![]),
        ("publisher:_", vec![]),
    ];
    for (text, expected) in cases {
        assert_eq!(titles(&mut lib, text, ALL), expected, "{text}");
        assert_eq!(titles(&mut lib, text, DEFAULT), expected, "{text}");
    }

    lib.add_book(BookAdd {
        tags: Some(vec!["50%_off".to_string()]),
        publisher: Some("Fifty%".to_string()),
        ..book_with_authors("Percent Book", &[])
    })
    .unwrap();
    let literal: Vec<(&str, Vec<&str>)> = vec![
        ("tags:%", vec!["Percent Book"]),
        ("tags:_", vec!["Percent Book"]),
        ("tags:\"0%_o\"", vec!["Percent Book"]),
        ("tags:\"0_%o\"", vec![]),
        ("tags:=\"50%_off\"", vec!["Percent Book"]),
        ("tags:=\"50%_of\"", vec![]),
        ("publisher:f_f", vec![]),
        ("publisher:\"y%\"", vec!["Percent Book"]),
    ];
    for (text, expected) in literal {
        assert_eq!(titles(&mut lib, text, ALL), expected, "{text}");
    }
}

#[test]
fn each_field_runs_its_true_and_false_branch() {
    let (_temp, mut lib) = fixture();
    let all_but_hobbit = ["Cien años de soledad", "Dune", "O'Brien Stories", "Re:Zero"];
    assert_eq!(titles(&mut lib, "authors:true", ALL).len(), 5);
    assert!(titles(&mut lib, "authors:false", ALL).is_empty());
    assert_eq!(titles(&mut lib, "series:true", ALL), ["The Hobbit"]);
    assert_eq!(titles(&mut lib, "series:false", ALL), all_but_hobbit);
    assert_eq!(titles(&mut lib, "comments:true", ALL), ["The Hobbit"]);
    assert_eq!(titles(&mut lib, "comments:false", ALL), all_but_hobbit);
    assert_eq!(titles(&mut lib, "formats:true", ALL), ["The Hobbit"]);
    assert_eq!(titles(&mut lib, "formats:false", ALL), all_but_hobbit);
    assert_eq!(
        titles(&mut lib, "languages:true", ALL),
        ["Cien años de soledad", "Dune", "The Hobbit", "Re:Zero"]
    );
    assert_eq!(
        titles(&mut lib, "languages:false", ALL),
        ["O'Brien Stories"]
    );
    assert_eq!(
        titles(&mut lib, "identifiers:true", ALL),
        ["Dune", "The Hobbit"]
    );
    assert_eq!(
        titles(&mut lib, "identifiers:false", ALL),
        ["Cien años de soledad", "O'Brien Stories", "Re:Zero"]
    );
}

#[test]
fn or_not_and_groups_combine() {
    let (_temp, mut lib) = fixture();
    assert_eq!(
        titles(&mut lib, "tags:fantasy or tags:\"science fiction\"", ALL),
        ["Dune", "The Hobbit"]
    );
    assert_eq!(
        titles(&mut lib, "not tags:fantasy", ALL),
        ["Cien años de soledad", "Dune", "O'Brien Stories", "Re:Zero"]
    );
    assert_eq!(
        titles(
            &mut lib,
            "(tags:fantasy or tags:\"light novel\") not authors:tolkien",
            ALL
        ),
        ["Re:Zero"]
    );
}

#[test]
fn identifier_forms_find_books() {
    let (_temp, mut lib) = fixture();
    assert_eq!(
        titles(&mut lib, "identifiers:false", ALL),
        ["Cien años de soledad", "O'Brien Stories", "Re:Zero"]
    );
    assert_eq!(titles(&mut lib, "isbn:9780547928227", ALL), ["The Hobbit"]);
    assert_eq!(titles(&mut lib, "identifiers:=goodreads:", ALL), ["Dune"]);
    assert_eq!(
        titles(&mut lib, "identifiers:=isbn:false", ALL),
        ["Cien años de soledad", "Dune", "O'Brien Stories", "Re:Zero"]
    );
}

#[test]
fn unknown_prefix_searches_text_and_returns_hint() {
    let (_temp, mut lib) = fixture();
    assert_eq!(titles(&mut lib, "re:zero", ALL), ["Re:Zero"]);
    assert_eq!(
        hints(&mut lib, "re:zero", ALL),
        [r#"No field named "re". Searched as text."#]
    );
    assert_eq!(titles(&mut lib, "re:", ALL), ["Re:Zero"]);
    assert!(hints(&mut lib, "re:", ALL).is_empty());
}

#[test]
fn quotes_and_sql_text_are_bound() {
    let (_temp, mut lib) = fixture();
    assert_eq!(titles(&mut lib, "title:o'brien", ALL), ["O'Brien Stories"]);
    assert!(titles(&mut lib, "title:\"'; DROP TABLE books; --\"", ALL).is_empty());
    assert_eq!(titles(&mut lib, "", ALL).len(), 5);
}

#[test]
fn non_ascii_values_find_books() {
    let (_temp, mut lib) = fixture();
    assert_eq!(titles(&mut lib, "años", ALL), ["Cien años de soledad"]);
    assert_eq!(titles(&mut lib, "garcía", ALL), ["Cien años de soledad"]);
    assert!(titles(&mut lib, "título:x", ALL).is_empty());
    let found = hints(&mut lib, "título:x", ALL);
    assert_eq!(found.len(), 1);
    assert!(found[0].contains("título"));
}

#[test]
fn invalid_text_returns_invalid_search() {
    let (_temp, mut lib) = fixture();
    assert_eq!(
        error(&mut lib, "tags:\"science", ALL),
        SearchError::MissingClosingQuote
    );
    assert!(matches!(
        lib.search_books("rating:>=4"),
        Err(CalibreError::InvalidSearch(Spanned {
            value: SearchError::UnsupportedField { name },
            ..
        })) if name == "rating"
    ));
}

#[test]
fn a_misspelled_field_in_a_custom_value_search_gives_a_hint_and_no_books() {
    let (_temp, mut lib) = fixture();
    let page = lib
        .query_books(BookQuery {
            custom_value: Some(CustomValueFilter {
                column_label: "no_such_column".to_string(),
                value_id: 1,
            }),
            ..text_query("titel:x")
        })
        .unwrap();
    assert!(page.items.is_empty());
    assert_eq!(hint_messages(&page), [TITEL_HINT]);
}

#[test]
fn a_search_books_error_range_counts_from_the_untrimmed_text() {
    let (_temp, mut lib) = fixture();
    assert!(matches!(
        lib.search_books("  x and"),
        Err(CalibreError::InvalidSearch(Spanned {
            value: SearchError::MissingTerm { .. },
            span,
        })) if span == (4..7)
    ));
}

#[test]
fn blank_text_matches_all_books_only_in_query_books() {
    let (_temp, mut lib) = fixture();
    assert_eq!(titles(&mut lib, "  ", ALL).len(), 5);
    assert!(lib.search_books("").unwrap().is_empty());
}

#[test]
fn page_and_total_agree() {
    let (_temp, mut lib) = fixture();
    for text in [
        "fantasy",
        "tags:fiction",
        "tags:fantasy or tags:\"science fiction\"",
        "not tags:fantasy",
        "identifiers:false",
        "re:zero",
    ] {
        let all = page(&mut lib, text, ALL).unwrap();
        assert_eq!(all.items.len() as u64, all.total, "{text}");
        let one = lib
            .query_books(BookQuery {
                limit: Some(1),
                search_scope: ALL,
                ..text_query(text)
            })
            .unwrap();
        assert_eq!(one.total, all.total, "{text}");
    }
}

#[test]
fn acquirable_books_use_the_grammar() {
    let (_temp, mut lib) = fixture();
    let page = lib
        .query_acquirable_books_with(text_query("tolkien"))
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].title, "The Hobbit");
    let page = lib
        .query_acquirable_books_with(text_query("herbert"))
        .unwrap();
    assert!(page.items.is_empty());
    let page = lib
        .query_acquirable_books_with(text_query("titel:hobbit"))
        .unwrap();
    assert_eq!(hint_messages(&page), [TITEL_HINT]);
    assert!(matches!(
        lib.query_acquirable_books_with(text_query("tags:\"x")),
        Err(CalibreError::InvalidSearch(_))
    ));
}

#[test]
fn a_missing_custom_column_gives_no_acquirable_books_and_keeps_the_hints() {
    let (_temp, mut lib) = fixture();
    let text = "tolkien or titel:x";
    let page = lib.query_acquirable_books_with(text_query(text)).unwrap();
    assert_eq!(page.items.len(), 1, "the text alone finds The Hobbit");

    let page = lib
        .query_acquirable_books_with(BookQuery {
            custom_value: Some(CustomValueFilter {
                column_label: "no_such_column".to_string(),
                value_id: 1,
            }),
            ..text_query(text)
        })
        .unwrap();
    assert!(page.items.is_empty());
    assert_eq!(page.total, 0);
    assert_eq!(hint_messages(&page), [TITEL_HINT]);
}

#[test]
fn default_scope_keeps_bare_words_on_titles_authors_and_series() {
    let (_temp, mut lib) = fixture();
    assert!(titles(&mut lib, "fantasy", DEFAULT).is_empty());
    assert!(titles(&mut lib, "chilton", DEFAULT).is_empty());
    assert!(titles(&mut lib, "9780547928227", DEFAULT).is_empty());
    assert_eq!(titles(&mut lib, "tolkien", DEFAULT), ["The Hobbit"]);
    assert_eq!(titles(&mut lib, "middle", DEFAULT), ["The Hobbit"]);
    assert_eq!(titles(&mut lib, "hobbit", DEFAULT), ["The Hobbit"]);
    assert_eq!(titles(&mut lib, "tags:fantasy", DEFAULT), ["The Hobbit"]);
    assert_eq!(
        titles(&mut lib, "isbn:9780547928227", DEFAULT),
        ["The Hobbit"]
    );
}

#[test]
fn search_books_uses_the_default_scope() {
    let (_temp, mut lib) = fixture();
    assert!(lib.search_books("fantasy").unwrap().is_empty());
    let found = lib.search_books("tolkien").unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].title, "The Hobbit");
}

#[test]
fn an_identifier_type_and_value_match_on_the_same_row() {
    let (_temp, mut lib) = fixture();
    lib.add_book(BookAdd {
        identifiers: HashMap::from([
            ("isbn".to_string(), "111".to_string()),
            ("goodreads".to_string(), "222".to_string()),
        ]),
        ..book_with_authors("Two Identifiers", &[])
    })
    .unwrap();
    assert!(titles(&mut lib, "isbn:222", DEFAULT).is_empty());
    assert!(titles(&mut lib, "identifiers:=isbn:=222", DEFAULT).is_empty());
    assert_eq!(
        titles(&mut lib, "identifiers:=goodreads:=222", DEFAULT),
        ["Two Identifiers"]
    );
    assert_eq!(titles(&mut lib, "isbn:111", DEFAULT), ["Two Identifiers"]);
}

#[test]
fn a_backslash_in_a_value_is_a_literal_character() {
    let (_temp, mut lib) = fixture();
    lib.add_book(book_with_authors(r"Back\slash", &[])).unwrap();
    assert_eq!(titles(&mut lib, r"title:k\\s", DEFAULT), [r"Back\slash"]);
    assert_eq!(titles(&mut lib, r"title:k\", DEFAULT), [r"Back\slash"]);
    assert!(titles(&mut lib, "title:ks", DEFAULT).is_empty());
}

#[test]
fn a_search_at_the_limits_runs_in_sqlite() {
    let (_temp, mut lib) = fixture();
    let words = (0..100)
        .map(|_| "brien".to_string())
        .collect::<Vec<_>>()
        .join(" ");
    assert_eq!(titles(&mut lib, &words, ALL), ["O'Brien Stories"]);
    let groups = format!("{}hobbit{}", "(".repeat(MAX_DEPTH), ")".repeat(MAX_DEPTH));
    assert_eq!(titles(&mut lib, &groups, ALL), ["The Hobbit"]);
    let percents = "%".repeat(20_000);
    assert!(titles(&mut lib, &percents, ALL).is_empty());
    assert_eq!(
        error(&mut lib, &"a".repeat(20_001), ALL),
        SearchError::TooLong
    );
}

/// The most levels of parentheses and `not` that the README gives.
const MAX_DEPTH: usize = 16;

/// `hobbit (dune or (hobbit (…)))`: `depth` groups that alternate `and`
/// and `or`, so that the parser cannot make them flat.
fn alternating_groups(depth: usize) -> String {
    (0..depth).fold("hobbit".to_string(), |inner, level| {
        let left = if level % 2 == 0 { "dune or" } else { "hobbit" };
        format!("{left} ({inner})")
    })
}

/// `not (dune or not (dune or …))`: `depth` levels of `not` and groups.
fn nested_nots(depth: usize) -> String {
    (0..depth / 2).fold("hobbit".to_string(), |inner, _| {
        format!("not (dune or {inner})")
    })
}

#[test]
fn the_deepest_searches_run_in_sqlite() {
    let (_temp, mut lib) = fixture();
    for scope in [DEFAULT, ALL] {
        for text in [
            alternating_groups(MAX_DEPTH),
            nested_nots(MAX_DEPTH),
            format!("{}hobbit", "not ".repeat(MAX_DEPTH)),
        ] {
            let result = page(&mut lib, &text, scope);
            assert!(result.is_ok(), "{scope:?} {text}: {result:?}");
        }
        for text in [
            alternating_groups(MAX_DEPTH + 1),
            nested_nots(MAX_DEPTH + 2),
        ] {
            assert_eq!(
                error(&mut lib, &text, scope),
                SearchError::TooDeep,
                "{text}"
            );
        }
    }
}

#[test]
fn a_top_level_or_stays_inside_the_other_filters() {
    let (_temp, mut lib) = fixture();
    let hobbit = lib.search_books("hobbit").unwrap().remove(0);
    let page = lib
        .query_books(BookQuery {
            author_id: Some(hobbit.authors[0].id),
            ..text_query("dune or hobbit")
        })
        .unwrap();
    assert_eq!(page_titles(&page), ["The Hobbit"]);
    assert_eq!(page.total, 1);

    let classic = lib
        .list_tags()
        .unwrap()
        .into_iter()
        .find(|tag| tag.name == "Classic")
        .unwrap();
    let page = lib
        .query_books(BookQuery {
            tag_id: Some(classic.id),
            ..text_query("dune or hobbit")
        })
        .unwrap();
    assert_eq!(page_titles(&page), ["The Hobbit"]);
    assert_eq!(page.total, 1);

    lib.set_book_read_state(hobbit.id, true).unwrap();
    let page = lib
        .query_books(BookQuery {
            hide_read: true,
            ..text_query("hobbit or dune")
        })
        .unwrap();
    assert_eq!(page_titles(&page), ["Dune"]);
    assert_eq!(page.total, 1);
}

#[test]
fn a_book_with_two_matching_values_appears_one_time() {
    let (_temp, mut lib) = fixture();
    lib.add_book(book_with_authors(
        "Two Annas",
        &["Anna Smith", "Anna Jones"],
    ))
    .unwrap();
    for text in ["authors:anna", "anna"] {
        let page = page(&mut lib, text, DEFAULT).unwrap();
        assert_eq!(page_titles(&page), ["Two Annas"], "{text}");
        assert_eq!(page.total, 1, "{text}");
    }
    assert_eq!(titles(&mut lib, "tags:classic", DEFAULT), ["The Hobbit"]);
    assert!(!titles(&mut lib, "not tags:classic", DEFAULT).contains(&"The Hobbit".to_string()));
}

#[test]
fn a_bare_word_skips_identifier_types_formats_and_languages() {
    let (_temp, mut lib) = fixture();
    for text in ["goodreads", "isbn", "epub", "jpn"] {
        assert!(titles(&mut lib, text, ALL).is_empty(), "{text}");
    }
}

#[test]
fn random_search_text_runs_or_gives_invalid_search() {
    use proptest::prelude::*;
    use proptest::test_runner::{TestCaseError, TestRunner};

    let (_temp, lib) = fixture();
    let lib = std::cell::RefCell::new(lib);
    let part = prop_oneof![
        Just("tags:".to_string()),
        Just("identifiers:".to_string()),
        Just("isbn:".to_string()),
        Just("\"".to_string()),
        Just("(".to_string()),
        Just(")".to_string()),
        Just(" or ".to_string()),
        Just(" and ".to_string()),
        Just("not ".to_string()),
        Just("=".to_string()),
        Just("\\".to_string()),
        Just(" ".to_string()),
        "[a-zé:%_]{1,5}",
    ];
    let strategy = (proptest::collection::vec(part, 0..40), proptest::bool::ANY);
    TestRunner::default()
        .run(&strategy, |(parts, all_fields)| {
            let text = parts.concat();
            let scope = if all_fields { ALL } else { DEFAULT };
            match page(&mut lib.borrow_mut(), &text, scope) {
                Ok(_) | Err(CalibreError::InvalidSearch(_)) => Ok(()),
                Err(other) => Err(TestCaseError::fail(format!("{text:?}: {other:?}"))),
            }
        })
        .unwrap();
}

#[test]
fn a_bare_equals_word_matches_a_whole_field() {
    let (_temp, mut lib) = fixture();
    for scope in [DEFAULT, ALL] {
        assert_eq!(titles(&mut lib, "=dune", scope), ["Dune"]);
        assert!(titles(&mut lib, "=dun", scope).is_empty());
        assert_eq!(titles(&mut lib, r"=frank\ herbert", scope), ["Dune"]);
        assert_eq!(titles(&mut lib, r#"="frank herbert""#, scope), ["Dune"]);
    }
    assert_eq!(titles(&mut lib, "=chilton", ALL), ["Dune"]);
    assert!(titles(&mut lib, "=chilton", DEFAULT).is_empty());
}

#[test]
fn a_comment_of_spaces_only_is_no_comment() {
    let (_temp, mut lib) = fixture();
    let stories = lib.search_books("o'brien").unwrap()[0].id;
    let mut conn = libcalibre::__internals::establish_connection(lib.database_path()).unwrap();
    sql_query("INSERT INTO comments (book, text) VALUES (?, '  ')")
        .bind::<Integer, _>(stories.as_i32())
        .execute(&mut conn)
        .unwrap();
    drop(conn);
    assert_eq!(titles(&mut lib, "comments:true", DEFAULT), ["The Hobbit"]);
    assert!(titles(&mut lib, "comments:false", DEFAULT).contains(&"O'Brien Stories".to_string()));
}

#[test]
fn case_folding_is_ascii_only() {
    let (_temp, mut lib) = fixture();
    assert_eq!(titles(&mut lib, "CIEN", DEFAULT), ["Cien años de soledad"]);
    assert!(
        titles(&mut lib, "AÑOS", DEFAULT).is_empty(),
        "SQLite LIKE folds ASCII letters only"
    );
}

#[test]
fn isbn_presence_and_absence() {
    let (_temp, mut lib) = fixture();
    assert_eq!(titles(&mut lib, "isbn:true", DEFAULT), ["The Hobbit"]);
    assert_eq!(
        titles(&mut lib, "isbn:false", DEFAULT),
        ["Cien años de soledad", "Dune", "O'Brien Stories", "Re:Zero"]
    );
    assert_eq!(
        error(&mut lib, "isbn:=", DEFAULT),
        SearchError::MissingValue {
            prefix: "isbn".into()
        }
    );
}

#[test]
fn hints_and_errors_have_the_byte_range_of_their_text() {
    let (_temp, mut lib) = fixture();
    let found = page(&mut lib, "  dune titel:x", DEFAULT).unwrap();
    assert_eq!(found.hints.len(), 1);
    assert_eq!(found.hints[0].span, 7..14);
    match page(&mut lib, "  dune and", DEFAULT) {
        Err(CalibreError::InvalidSearch(error)) => assert_eq!(error.span, 7..10),
        other => panic!("expected InvalidSearch, got {other:?}"),
    }
}
