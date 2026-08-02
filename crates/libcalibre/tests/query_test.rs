// Tests for Library::query_books — paged, sorted, filtered book queries.
// This binary uses only a subset of the shared test helpers.
#[allow(dead_code, unused_imports)]
mod common;

use common::setup_with_library;
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{Integer, Text};
use libcalibre::{BookAdd, BookId, BookPage, BookQuery, BookSortOrder, Library};
use std::collections::HashMap;

fn book(title: &str, author_names: &[&str]) -> BookAdd {
    BookAdd {
        title: title.to_string(),
        author_names: author_names.iter().map(|n| (*n).to_string()).collect(),
        tags: None,
        series: None,
        series_index: None,
        publisher: None,
        publication_date: None,
        rating: None,
        comments: None,
        identifiers: HashMap::new(),
        language: None,
        file_paths: vec![],
    }
}

fn query(lib: &mut Library, q: BookQuery) -> BookPage {
    lib.query_books(q).unwrap()
}

fn titles(page: &BookPage) -> Vec<String> {
    page.items.iter().map(|b| b.title.clone()).collect()
}

fn series_id_by_name(lib: &mut Library, name: &str) -> i32 {
    #[derive(QueryableByName)]
    struct IdRow {
        #[diesel(sql_type = Integer)]
        id: i32,
    }

    let mut conn = libcalibre::persistence::establish_connection(lib.database_path())
        .expect("failed to open test db");
    let row: IdRow = sql_query("SELECT id FROM series WHERE name = ?")
        .bind::<Text, _>(name)
        .get_result(&mut conn)
        .expect("series not found");
    row.id
}

fn tag_id_by_name(lib: &mut Library, name: &str) -> i32 {
    lib.list_tags()
        .unwrap()
        .into_iter()
        .find(|tag| tag.name == name)
        .expect("tag not found")
        .id
}

// =============================================================================
// Paging
// =============================================================================

#[test]
fn test_pages_tile_the_full_set() {
    let (_temp, mut lib) = setup_with_library();

    for n in 1..=7 {
        lib.add_book(book(&format!("Book {n:02}"), &["Some Author"]))
            .unwrap();
    }

    let unpaged = query(&mut lib, BookQuery::default());
    assert_eq!(unpaged.items.len(), 7);
    assert_eq!(unpaged.total, 7);

    let mut tiled: Vec<BookId> = Vec::new();
    for page_index in 0..3 {
        let page = query(
            &mut lib,
            BookQuery {
                limit: Some(3),
                offset: page_index * 3,
                ..BookQuery::default()
            },
        );
        // Total stays constant across pages and ignores limit/offset.
        assert_eq!(page.total, 7);
        tiled.extend(page.items.iter().map(|b| b.id));
    }

    let unpaged_ids: Vec<BookId> = unpaged.items.iter().map(|b| b.id).collect();
    assert_eq!(tiled, unpaged_ids);
}

#[test]
fn test_partial_last_page() {
    let (_temp, mut lib) = setup_with_library();

    for n in 1..=5 {
        lib.add_book(book(&format!("Book {n:02}"), &[])).unwrap();
    }

    let page = query(
        &mut lib,
        BookQuery {
            limit: Some(3),
            offset: 3,
            ..BookQuery::default()
        },
    );
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.total, 5);
}

#[test]
fn test_offset_past_end_is_empty() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_book(book("Only Book", &[])).unwrap();

    let page = query(
        &mut lib,
        BookQuery {
            limit: Some(10),
            offset: 5,
            ..BookQuery::default()
        },
    );
    assert!(page.items.is_empty());
    assert_eq!(page.total, 1);
}

// =============================================================================
// Sorting
// =============================================================================

fn sorting_fixture(lib: &mut Library) {
    // Title sort uses books.sort, so "The Zebra Guide" sorts as
    // "Zebra Guide, The". Author sort uses authors.sort (APA style).
    lib.add_book(book("The Zebra Guide", &["Jane Austen"]))
        .unwrap();
    lib.add_book(book("Apple Picking", &["Herman Melville"]))
        .unwrap();
    lib.add_book(book("Mangoes", &["Charles Dickens"])).unwrap();
}

#[test]
fn test_sort_title_asc() {
    let (_temp, mut lib) = setup_with_library();
    sorting_fixture(&mut lib);

    let page = query(
        &mut lib,
        BookQuery {
            sort: BookSortOrder::TitleAsc,
            ..BookQuery::default()
        },
    );
    assert_eq!(
        titles(&page),
        ["Apple Picking", "Mangoes", "The Zebra Guide"]
    );
}

#[test]
fn test_sort_title_desc() {
    let (_temp, mut lib) = setup_with_library();
    sorting_fixture(&mut lib);

    let page = query(
        &mut lib,
        BookQuery {
            sort: BookSortOrder::TitleDesc,
            ..BookQuery::default()
        },
    );
    assert_eq!(
        titles(&page),
        ["The Zebra Guide", "Mangoes", "Apple Picking"]
    );
}

#[test]
fn test_sort_author_asc() {
    let (_temp, mut lib) = setup_with_library();
    sorting_fixture(&mut lib);

    let page = query(
        &mut lib,
        BookQuery {
            sort: BookSortOrder::AuthorAsc,
            ..BookQuery::default()
        },
    );
    // Austen < Dickens < Melville
    assert_eq!(
        titles(&page),
        ["The Zebra Guide", "Mangoes", "Apple Picking"]
    );
}

#[test]
fn test_sort_updated_desc_uses_id_as_stable_tiebreaker() {
    let (_temp, mut lib) = setup_with_library();
    let older = lib.add_book(book("Older", &[])).unwrap();
    let newer_first = lib.add_book(book("Newer First", &[])).unwrap();
    let newer_second = lib.add_book(book("Newer Second", &[])).unwrap();

    let mut conn = libcalibre::persistence::establish_connection(lib.database_path()).unwrap();
    sql_query("UPDATE books SET last_modified = '2024-01-01 00:00:00' WHERE id = ?")
        .bind::<Integer, _>(older.id.as_i32())
        .execute(&mut conn)
        .unwrap();
    sql_query("UPDATE books SET last_modified = '2024-02-01 00:00:00' WHERE id IN (?, ?)")
        .bind::<Integer, _>(newer_first.id.as_i32())
        .bind::<Integer, _>(newer_second.id.as_i32())
        .execute(&mut conn)
        .unwrap();

    let page = query(
        &mut lib,
        BookQuery {
            sort: BookSortOrder::UpdatedDesc,
            ..BookQuery::default()
        },
    );
    assert_eq!(titles(&page), ["Newer Second", "Newer First", "Older"]);
}

#[test]
fn test_sort_series_index_handles_fractions_and_stable_ties() {
    let (_temp, mut lib) = setup_with_library();
    for (title, index) in [
        ("Second B", 2.0),
        ("First", 1.0),
        ("Second A", 2.0),
        ("Bridge", 1.5),
    ] {
        lib.add_book(BookAdd {
            series: Some("Saga".to_string()),
            series_index: Some(index),
            ..book(title, &[])
        })
        .unwrap();
    }
    let saga = series_id_by_name(&mut lib, "Saga");

    let page = query(
        &mut lib,
        BookQuery {
            series_id: Some(saga),
            sort: BookSortOrder::SeriesIndexAsc,
            ..BookQuery::default()
        },
    );
    assert_eq!(titles(&page), ["First", "Bridge", "Second A", "Second B"]);
}

#[test]
fn test_sort_author_desc() {
    let (_temp, mut lib) = setup_with_library();
    sorting_fixture(&mut lib);

    let page = query(
        &mut lib,
        BookQuery {
            sort: BookSortOrder::AuthorDesc,
            ..BookQuery::default()
        },
    );
    assert_eq!(
        titles(&page),
        ["Apple Picking", "Mangoes", "The Zebra Guide"]
    );
}

#[test]
fn test_sort_ties_break_by_book_id() {
    let (_temp, mut lib) = setup_with_library();

    let first = lib.add_book(book("Same Title", &[])).unwrap();
    let second = lib.add_book(book("Same Title", &[])).unwrap();

    let asc = query(
        &mut lib,
        BookQuery {
            sort: BookSortOrder::TitleAsc,
            ..BookQuery::default()
        },
    );
    let asc_ids: Vec<BookId> = asc.items.iter().map(|b| b.id).collect();
    assert_eq!(asc_ids, [first.id, second.id]);

    let desc = query(
        &mut lib,
        BookQuery {
            sort: BookSortOrder::TitleDesc,
            ..BookQuery::default()
        },
    );
    let desc_ids: Vec<BookId> = desc.items.iter().map(|b| b.id).collect();
    assert_eq!(desc_ids, [second.id, first.id]);
}

// =============================================================================
// Text filter
// =============================================================================

#[test]
fn test_empty_text_matches_all_books() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_book(book("Book One", &[])).unwrap();
    lib.add_book(book("Book Two", &[])).unwrap();

    for text in [None, Some(String::new()), Some("   \t\n".to_string())] {
        let page = query(
            &mut lib,
            BookQuery {
                text,
                ..BookQuery::default()
            },
        );
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.total, 2);
    }
}

#[test]
fn test_text_matches_title_author_and_series() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_book(book("The Rust Programming Language", &["Steve Klabnik"]))
        .unwrap();
    lib.add_book(book("Pride and Prejudice", &["Jane Austen"]))
        .unwrap();
    lib.add_book(BookAdd {
        series: Some("The Lord of the Rings".to_string()),
        series_index: Some(1.0),
        ..book("The Fellowship of the Ring", &["J. R. R. Tolkien"])
    })
    .unwrap();

    let by_title = query(
        &mut lib,
        BookQuery {
            text: Some("RUST".to_string()),
            ..BookQuery::default()
        },
    );
    assert_eq!(titles(&by_title), ["The Rust Programming Language"]);
    assert_eq!(by_title.total, 1);

    let by_author = query(
        &mut lib,
        BookQuery {
            text: Some("austen".to_string()),
            ..BookQuery::default()
        },
    );
    assert_eq!(titles(&by_author), ["Pride and Prejudice"]);

    let by_series = query(
        &mut lib,
        BookQuery {
            text: Some("lord of the rings".to_string()),
            ..BookQuery::default()
        },
    );
    assert_eq!(titles(&by_series), ["The Fellowship of the Ring"]);
}

#[test]
fn test_text_escapes_like_wildcards() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_book(book("100% Done", &[])).unwrap();
    lib.add_book(book("Another Book", &[])).unwrap();

    let page = query(
        &mut lib,
        BookQuery {
            text: Some("100%".to_string()),
            ..BookQuery::default()
        },
    );
    assert_eq!(titles(&page), ["100% Done"]);
    assert_eq!(page.total, 1);

    let no_match = query(
        &mut lib,
        BookQuery {
            text: Some("z%y".to_string()),
            ..BookQuery::default()
        },
    );
    assert!(no_match.items.is_empty());
    assert_eq!(no_match.total, 0);
}

// =============================================================================
// Author, series, and read-state filters
// =============================================================================

#[test]
fn test_author_id_filter() {
    let (_temp, mut lib) = setup_with_library();

    let emma = lib.add_book(book("Emma", &["Jane Austen"])).unwrap();
    lib.add_book(book("Persuasion", &["Jane Austen"])).unwrap();
    lib.add_book(book("Moby Dick", &["Herman Melville"]))
        .unwrap();

    let page = query(
        &mut lib,
        BookQuery {
            author_id: Some(emma.authors[0].id),
            ..BookQuery::default()
        },
    );
    assert_eq!(titles(&page), ["Emma", "Persuasion"]);
    assert_eq!(page.total, 2);
}

#[test]
fn test_author_id_and_text_compose() {
    let (_temp, mut lib) = setup_with_library();

    let emma = lib.add_book(book("Emma", &["Jane Austen"])).unwrap();
    lib.add_book(book("Persuasion", &["Jane Austen"])).unwrap();
    lib.add_book(book("Emma: A Biography", &["Herman Melville"]))
        .unwrap();

    let page = query(
        &mut lib,
        BookQuery {
            text: Some("emma".to_string()),
            author_id: Some(emma.authors[0].id),
            ..BookQuery::default()
        },
    );
    assert_eq!(titles(&page), ["Emma"]);
    assert_eq!(page.total, 1);
}

#[test]
fn test_series_id_filter() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_book(BookAdd {
        series: Some("Earthsea".to_string()),
        series_index: Some(1.0),
        ..book("A Wizard of Earthsea", &["Ursula K. Le Guin"])
    })
    .unwrap();
    lib.add_book(BookAdd {
        series: Some("Earthsea".to_string()),
        series_index: Some(2.0),
        ..book("The Tombs of Atuan", &["Ursula K. Le Guin"])
    })
    .unwrap();
    lib.add_book(book("Unrelated Book", &["Ursula K. Le Guin"]))
        .unwrap();

    let earthsea_id = series_id_by_name(&mut lib, "Earthsea");

    let page = query(
        &mut lib,
        BookQuery {
            series_id: Some(earthsea_id),
            ..BookQuery::default()
        },
    );
    assert_eq!(
        titles(&page),
        ["The Tombs of Atuan", "A Wizard of Earthsea"]
    );
    assert_eq!(page.total, 2);
}

#[test]
fn test_hide_read_filters_in_sql() {
    let (_temp, mut lib) = setup_with_library();

    let read_book = lib.add_book(book("Already Read", &[])).unwrap();
    let unread_then_read = lib.add_book(book("Toggled Back", &[])).unwrap();
    lib.add_book(book("Never Touched", &[])).unwrap();

    lib.set_book_read_state(read_book.id, true).unwrap();
    // A book toggled read then unread (stored value 0) stays visible.
    lib.set_book_read_state(unread_then_read.id, true).unwrap();
    lib.set_book_read_state(unread_then_read.id, false).unwrap();

    let page = query(
        &mut lib,
        BookQuery {
            hide_read: true,
            ..BookQuery::default()
        },
    );
    assert_eq!(titles(&page), ["Never Touched", "Toggled Back"]);
    // Totals come from the same SQL filter, not post-hydration filtering.
    assert_eq!(page.total, 2);

    let all = query(&mut lib, BookQuery::default());
    assert_eq!(all.total, 3);
}

#[test]
fn test_hide_read_with_no_read_column_matches_all() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_book(book("Fresh Library Book", &[])).unwrap();

    // No book has ever been marked read, so the custom column may not exist.
    let page = query(
        &mut lib,
        BookQuery {
            hide_read: true,
            ..BookQuery::default()
        },
    );
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.total, 1);
    assert!(lib
        .custom_columns()
        .unwrap()
        .iter()
        .all(|column| column.label != "read"));
}

#[test]
fn test_hide_read_respects_paging_and_totals() {
    let (_temp, mut lib) = setup_with_library();

    let mut unread_titles = Vec::new();
    for n in 1..=6 {
        let added = lib.add_book(book(&format!("Book {n:02}"), &[])).unwrap();
        if n % 2 == 0 {
            lib.set_book_read_state(added.id, true).unwrap();
        } else {
            unread_titles.push(format!("Book {n:02}"));
        }
    }

    let first_page = query(
        &mut lib,
        BookQuery {
            hide_read: true,
            limit: Some(2),
            offset: 0,
            ..BookQuery::default()
        },
    );
    assert_eq!(titles(&first_page), unread_titles[0..2]);
    assert_eq!(first_page.total, 3);

    let last_page = query(
        &mut lib,
        BookQuery {
            hide_read: true,
            limit: Some(2),
            offset: 2,
            ..BookQuery::default()
        },
    );
    assert_eq!(titles(&last_page), unread_titles[2..3]);
    assert_eq!(last_page.total, 3);
}

// =============================================================================
// Hydration
// =============================================================================

#[test]
fn test_page_items_are_hydrated() {
    let (_temp, mut lib) = setup_with_library();

    let added = lib
        .add_book(BookAdd {
            series: Some("Earthsea".to_string()),
            series_index: Some(1.0),
            tags: Some(vec!["fantasy".to_string()]),
            ..book("A Wizard of Earthsea", &["Ursula K. Le Guin"])
        })
        .unwrap();
    lib.set_book_read_state(added.id, true).unwrap();

    let page = query(&mut lib, BookQuery::default());
    assert_eq!(page.items.len(), 1);

    let item = &page.items[0];
    assert_eq!(item.title, "A Wizard of Earthsea");
    assert_eq!(item.authors.len(), 1);
    assert_eq!(item.authors[0].name, "Ursula K. Le Guin");
    assert_eq!(item.series.as_deref(), Some("Earthsea"));
    assert_eq!(item.series_index, Some(1.0));
    assert_eq!(item.tags, ["fantasy"]);
    assert!(item.is_read);
}

// =============================================================================
// Tag listing
// =============================================================================

#[test]
fn test_list_authors_returns_counts_sorted_case_insensitively() {
    let (_temp, mut lib) = setup_with_library();
    lib.add_book(book("First", &["zebra", "Alpha"])).unwrap();
    lib.add_book(book("Second", &["zebra"])).unwrap();

    let authors = lib.list_authors().unwrap();
    let summary: Vec<_> = authors
        .iter()
        .map(|author| (author.name.as_str(), author.book_count))
        .collect();
    assert_eq!(summary, [("Alpha", 1), ("zebra", 2)]);
}

#[test]
fn test_tag_filter_composes_with_paging_and_totals() {
    let (_temp, mut lib) = setup_with_library();

    for title in ["Alpha", "Beta", "Gamma"] {
        lib.add_book(BookAdd {
            tags: Some(vec!["Selected".to_string()]),
            ..book(title, &[])
        })
        .unwrap();
    }
    lib.add_book(BookAdd {
        tags: Some(vec!["Other".to_string()]),
        ..book("Excluded", &[])
    })
    .unwrap();

    let selected_tag = tag_id_by_name(&mut lib, "Selected");
    let page = query(
        &mut lib,
        BookQuery {
            tag_id: Some(selected_tag),
            limit: Some(2),
            offset: 1,
            ..BookQuery::default()
        },
    );
    assert_eq!(titles(&page), ["Beta", "Gamma"]);
    assert_eq!(page.total, 3);
}

#[test]
fn test_acquirable_query_composes_filters_and_excludes_fileless_books() {
    let (temp, mut lib) = setup_with_library();
    let source = temp.path().join("source.epub");
    std::fs::write(&source, b"epub").unwrap();

    for title in ["Alpha Match", "Beta Match"] {
        lib.add_book(BookAdd {
            tags: Some(vec!["Selected".to_string()]),
            file_paths: vec![source.clone()],
            ..book(title, &["Writer"])
        })
        .unwrap();
    }
    lib.add_book(BookAdd {
        tags: Some(vec!["Selected".to_string()]),
        ..book("Fileless Match", &["Writer"])
    })
    .unwrap();
    lib.add_book(BookAdd {
        tags: Some(vec!["Other".to_string()]),
        file_paths: vec![source],
        ..book("Other Match", &["Writer"])
    })
    .unwrap();

    let selected_tag = tag_id_by_name(&mut lib, "Selected");
    let page = lib
        .query_acquirable_books_with(BookQuery {
            text: Some("match".to_string()),
            tag_id: Some(selected_tag),
            limit: Some(1),
            offset: 1,
            ..BookQuery::default()
        })
        .unwrap();
    assert_eq!(titles(&page), ["Beta Match"]);
    assert_eq!(page.total, 2);
    assert_eq!(page.items[0].files.len(), 1);
}

#[test]
fn test_list_tags_returns_deduped_vocabulary_sorted_by_name() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_book(BookAdd {
        tags: Some(vec!["fantasy".to_string(), "Adventure".to_string()]),
        ..book("A Wizard of Earthsea", &["Ursula K. Le Guin"])
    })
    .unwrap();
    // "FANTASY" matches the existing "fantasy" case-insensitively, so the
    // vocabulary keeps the first spelling instead of growing a duplicate.
    lib.add_book(BookAdd {
        tags: Some(vec!["FANTASY".to_string(), "banned".to_string()]),
        ..book("The Tombs of Atuan", &["Ursula K. Le Guin"])
    })
    .unwrap();
    lib.add_book(book("Untagged", &["Nobody"])).unwrap();

    let tags = lib.list_tags().unwrap();
    let names: Vec<&str> = tags.iter().map(|t| t.name.as_str()).collect();
    // Case-insensitive name sort: Adventure < banned < fantasy.
    assert_eq!(names, ["Adventure", "banned", "fantasy"]);

    // Ids are the real `tags` rows, each one distinct.
    let mut ids: Vec<i32> = tags.iter().map(|t| t.id).collect();
    ids.dedup();
    assert_eq!(ids.len(), 3);
}

#[test]
fn test_list_tags_empty_library() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_book(book("No Tags Here", &[])).unwrap();

    assert!(lib.list_tags().unwrap().is_empty());
}

// =============================================================================
// Series listing
// =============================================================================

#[test]
fn test_list_series_returns_counts_sorted_by_name() {
    let (_temp, mut lib) = setup_with_library();

    for n in 1u8..=2 {
        lib.add_book(BookAdd {
            series: Some("Earthsea".to_string()),
            series_index: Some(f32::from(n)),
            ..book(&format!("Earthsea {n}"), &["Ursula K. Le Guin"])
        })
        .unwrap();
    }
    lib.add_book(BookAdd {
        series: Some("Culture".to_string()),
        series_index: Some(1.0),
        ..book("Consider Phlebas", &["Iain M. Banks"])
    })
    .unwrap();
    lib.add_book(book("Standalone", &["Nobody"])).unwrap();

    let series = lib.list_series().unwrap();
    let names: Vec<&str> = series.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["Culture", "Earthsea"]);

    let counts: Vec<i64> = series.iter().map(|s| s.book_count).collect();
    assert_eq!(counts, [1, 2]);

    // The listed ids are the ones BookQuery::series_id filters on.
    let earthsea = series.iter().find(|s| s.name == "Earthsea").unwrap();
    assert_eq!(earthsea.id, series_id_by_name(&mut lib, "Earthsea"));
}
