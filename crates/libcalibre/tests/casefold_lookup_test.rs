// Tests for the Unicode case folding of the name lookups: a tag, author,
// series, publisher or custom column value in another letter case links the
// existing row.
// This binary uses only a subset of the shared test helpers.
#[allow(dead_code, unused_imports)]
mod common;

use common::setup_with_library;
use diesel::prelude::*;
use diesel::sql_types::Text;
use libcalibre::__internals::establish_connection;
use libcalibre::{
    BookAdd, BookId, BookQuery, BookUpdate, CustomColumnKind, CustomColumnSpec, CustomValue,
    Library,
};
use std::collections::HashMap;

fn book(title: &str) -> BookAdd {
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

fn add_tagged(lib: &mut Library, title: &str, tag: &str) -> BookId {
    lib.add_book(BookAdd {
        tags: Some(vec![tag.to_string()]),
        ..book(title)
    })
    .unwrap()
    .id
}

fn tag_names(lib: &mut Library) -> Vec<String> {
    let mut names: Vec<String> = lib
        .list_tags()
        .unwrap()
        .into_iter()
        .map(|tag| tag.name)
        .collect();
    names.sort();
    names
}

fn book_tags(lib: &mut Library, id: BookId) -> Vec<String> {
    lib.query_books(BookQuery::default())
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.id == id)
        .expect("the book exists")
        .tags
}

#[test]
fn test_cyrillic_tag_links_existing_tag() {
    let (_temp, mut lib) = setup_with_library();
    add_tagged(&mut lib, "Первая", "Фэнтези");
    add_tagged(&mut lib, "Вторая", "фэнтези");

    let tags = lib.list_tags().unwrap();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].name, "Фэнтези");
    assert_eq!(tags[0].book_count, 2);
}

#[test]
fn test_cyrillic_author_links_existing_author() {
    let (_temp, mut lib) = setup_with_library();
    lib.add_book(BookAdd {
        author_names: vec!["Лев Толстой".to_string()],
        ..book("Детство")
    })
    .unwrap();
    lib.add_book(BookAdd {
        author_names: vec!["ЛЕВ ТОЛСТОЙ".to_string()],
        ..book("Отрочество")
    })
    .unwrap();

    let names: Vec<String> = lib
        .authors()
        .unwrap()
        .into_iter()
        .map(|author| author.name)
        .collect();
    assert_eq!(names, ["Лев Толстой"]);
}

#[test]
fn test_cyrillic_series_links_existing_series() {
    let (_temp, mut lib) = setup_with_library();
    for (title, series) in [("Первая", "Сказки"), ("Вторая", "СКАЗКИ")] {
        lib.add_book(BookAdd {
            series: Some(series.to_string()),
            series_index: Some(1.0),
            ..book(title)
        })
        .unwrap();
    }

    let names: Vec<String> = lib
        .list_series()
        .unwrap()
        .into_iter()
        .map(|series| series.name)
        .collect();
    assert_eq!(names, ["Сказки"]);
}

#[test]
fn test_cyrillic_publisher_links_existing_publisher() {
    let (_temp, mut lib) = setup_with_library();
    for (title, publisher) in [("Первая", "Эксмо"), ("Вторая", "ЭКСМО")] {
        lib.add_book(BookAdd {
            publisher: Some(publisher.to_string()),
            ..book(title)
        })
        .unwrap();
    }

    let names: Vec<String> = lib
        .list_publishers()
        .unwrap()
        .into_iter()
        .map(|publisher| publisher.name)
        .collect();
    assert_eq!(names, ["Эксмо"]);
}

#[test]
fn test_cyrillic_custom_value_links_existing_value() {
    let (_temp, mut lib) = setup_with_library();
    let column = lib
        .create_custom_column(CustomColumnSpec {
            label: "genres".to_string(),
            name: "genres".to_string(),
            kind: CustomColumnKind::Text,
            is_multiple: true,
            enum_values: vec![],
            display: None,
        })
        .unwrap();
    for (title, value) in [("Первая", "Фэнтези"), ("Вторая", "фэнтези")] {
        let id = lib.add_book(book(title)).unwrap().id;
        lib.set_custom_value(
            id,
            column.id,
            Some(CustomValue::TextMultiple(vec![value.to_string()])),
        )
        .unwrap();
    }

    let values = lib.list_custom_column_values("genres").unwrap();
    assert_eq!(values.len(), 1);
    assert_eq!(values[0].name, "Фэнтези");
    assert_eq!(values[0].book_count, 2);
}

#[test]
fn test_yo_tag_links_ye_tag() {
    let (_temp, mut lib) = setup_with_library();
    add_tagged(&mut lib, "Первая", "Ёжик");
    add_tagged(&mut lib, "Вторая", "ежик");

    assert_eq!(tag_names(&mut lib), ["Ёжик"]);
}

fn book_author_names(lib: &mut Library, id: BookId) -> Vec<String> {
    lib.query_books(BookQuery::default())
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.id == id)
        .expect("the book exists")
        .authors
        .into_iter()
        .map(|author| author.name)
        .collect()
}

#[test]
fn test_add_book_with_tags_that_fold_together_links_one_tag() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            tags: Some(vec!["Ёжик".to_string(), "ежик".to_string()]),
            ..book("Книга")
        })
        .unwrap();

    assert_eq!(book_tags(&mut lib, book.id), ["Ёжик"]);
    assert_eq!(tag_names(&mut lib), ["Ёжик"]);
}

#[test]
fn test_update_book_adds_a_tag_that_folds_to_a_linked_tag() {
    let (_temp, mut lib) = setup_with_library();
    let id = add_tagged(&mut lib, "Книга", "Ёжик");

    lib.update_book(
        id,
        BookUpdate {
            tags: Some(vec!["Ёжик".to_string(), "ежик".to_string()]),
            ..BookUpdate::default()
        },
    )
    .unwrap();

    assert_eq!(book_tags(&mut lib, id), ["Ёжик"]);
}

#[test]
fn test_add_book_with_authors_that_fold_together_links_one_author() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            author_names: vec!["Лев Толстой".to_string(), "ЛЕВ ТОЛСТОЙ".to_string()],
            ..book("Детство")
        })
        .unwrap();

    assert_eq!(book_author_names(&mut lib, book.id), ["Лев Толстой"]);
}

#[test]
fn test_update_book_adds_an_author_that_folds_to_a_linked_author() {
    let (_temp, mut lib) = setup_with_library();
    let id = lib
        .add_book(BookAdd {
            author_names: vec!["Лев Толстой".to_string()],
            ..book("Детство")
        })
        .unwrap()
        .id;

    lib.update_book(
        id,
        BookUpdate {
            author_names: Some(vec!["Лев Толстой".to_string(), "ЛЕВ ТОЛСТОЙ".to_string()]),
            ..BookUpdate::default()
        },
    )
    .unwrap();

    assert_eq!(book_author_names(&mut lib, id), ["Лев Толстой"]);
}

#[test]
fn test_nfd_author_links_nfc_author() {
    let (_temp, mut lib) = setup_with_library();
    for (title, author) in [
        ("Discours", "Ren\u{00E9} Descartes"),
        ("Meditationes", "Rene\u{0301} Descartes"),
    ] {
        lib.add_book(BookAdd {
            author_names: vec![author.to_string()],
            ..book(title)
        })
        .unwrap();
    }

    let names: Vec<String> = lib
        .authors()
        .unwrap()
        .into_iter()
        .map(|author| author.name)
        .collect();
    assert_eq!(names, ["Ren\u{00E9} Descartes"]);
}

// The rules of the folded step, for each of the five lookups. Each lookup has
// its own indexed query, so each one gets each rule.

#[derive(Clone, Copy, Debug)]
enum Lookup {
    Author,
    Tag,
    Series,
    Publisher,
    CustomValue,
}

const LOOKUPS: [Lookup; 5] = [
    Lookup::Author,
    Lookup::Tag,
    Lookup::Series,
    Lookup::Publisher,
    Lookup::CustomValue,
];

/// A library for `lookup`, with the text custom column "genres" for
/// `Lookup::CustomValue`.
struct LookupLibrary {
    _temp: tempfile::TempDir,
    lib: Library,
    lookup: Lookup,
    column_id: i32,
}

impl LookupLibrary {
    fn new(lookup: Lookup) -> Self {
        let (temp, mut lib) = setup_with_library();
        let column_id = lib
            .create_custom_column(CustomColumnSpec {
                label: "genres".to_string(),
                name: "genres".to_string(),
                kind: CustomColumnKind::Text,
                is_multiple: true,
                enum_values: vec![],
                display: None,
            })
            .unwrap()
            .id;
        Self {
            _temp: temp,
            lib,
            lookup,
            column_id,
        }
    }

    /// Inserts the values in this sequence, with no lookup, so that the
    /// library can hold values that fold to the same text.
    fn insert_raw(&self, values: &[&str]) {
        let (table, column) = match self.lookup {
            Lookup::Author => ("authors".to_string(), "name"),
            Lookup::Tag => ("tags".to_string(), "name"),
            Lookup::Series => ("series".to_string(), "name"),
            Lookup::Publisher => ("publishers".to_string(), "name"),
            Lookup::CustomValue => (format!("custom_column_{}", self.column_id), "value"),
        };
        let mut conn = establish_connection(self.lib.database_path()).unwrap();
        for value in values {
            diesel::sql_query(format!("INSERT INTO {table} ({column}) VALUES (?)"))
                .bind::<Text, _>(*value)
                .execute(&mut conn)
                .unwrap();
        }
    }

    /// Adds a book that links `value` through the lookup.
    fn add(&mut self, value: &str) -> BookId {
        let value = value.to_string();
        let add = match self.lookup {
            Lookup::Author => BookAdd {
                author_names: vec![value.clone()],
                ..book("Книга")
            },
            Lookup::Tag => BookAdd {
                tags: Some(vec![value.clone()]),
                ..book("Книга")
            },
            Lookup::Series => BookAdd {
                series: Some(value.clone()),
                series_index: Some(1.0),
                ..book("Книга")
            },
            Lookup::Publisher => BookAdd {
                publisher: Some(value.clone()),
                ..book("Книга")
            },
            Lookup::CustomValue => book("Книга"),
        };
        let id = self.lib.add_book(add).unwrap().id;
        if let Lookup::CustomValue = self.lookup {
            self.lib
                .set_custom_value(
                    id,
                    self.column_id,
                    Some(CustomValue::TextMultiple(vec![value])),
                )
                .unwrap();
        }
        id
    }

    /// The values that the book links through the lookup.
    fn linked(&mut self, id: BookId) -> Vec<String> {
        if let Lookup::CustomValue = self.lookup {
            return match self.lib.get_custom_value(id, self.column_id).unwrap() {
                Some(CustomValue::TextMultiple(values)) => values,
                other => panic!("expected TextMultiple, got {other:?}"),
            };
        }
        let book = self
            .lib
            .query_books(BookQuery::default())
            .unwrap()
            .items
            .into_iter()
            .find(|item| item.id == id)
            .expect("the book exists");
        match self.lookup {
            Lookup::Author => book.authors.into_iter().map(|a| a.name).collect(),
            Lookup::Tag => book.tags,
            Lookup::Series => book.series.into_iter().collect(),
            Lookup::Publisher => book.publisher.into_iter().collect(),
            Lookup::CustomValue => unreachable!(),
        }
    }

    /// The count of stored values of the lookup.
    fn stored_count(&mut self) -> usize {
        match self.lookup {
            Lookup::Author => self.lib.authors().unwrap().len(),
            Lookup::Tag => self.lib.list_tags().unwrap().len(),
            Lookup::Series => self.lib.list_series().unwrap().len(),
            Lookup::Publisher => self.lib.list_publishers().unwrap().len(),
            Lookup::CustomValue => self.lib.list_custom_column_values("genres").unwrap().len(),
        }
    }
}

#[test]
fn test_exact_match_wins_over_folded_match() {
    for lookup in LOOKUPS {
        let mut fixture = LookupLibrary::new(lookup);
        fixture.insert_raw(&["Фэнтези", "фэнтези"]);

        let id = fixture.add("фэнтези");

        assert_eq!(fixture.linked(id), ["фэнтези"], "{lookup:?}");
    }
}

#[test]
fn test_lowest_id_wins_among_folded_duplicates() {
    for lookup in LOOKUPS {
        let mut fixture = LookupLibrary::new(lookup);
        // The lower-case value gets the lower id. The NOCASE index puts
        // "Фэнтези" first, so a scan in index order gives the other row.
        fixture.insert_raw(&["фэнтези", "Фэнтези"]);

        let id = fixture.add("ФЭНТЕЗИ");

        assert_eq!(fixture.linked(id), ["фэнтези"], "{lookup:?}");
    }
}

#[test]
fn test_ascii_input_does_not_link_sharp_s() {
    for lookup in LOOKUPS {
        let mut fixture = LookupLibrary::new(lookup);
        fixture.add("Straße");
        let before = fixture.stored_count();

        fixture.add("STRASSE");

        assert_eq!(fixture.stored_count(), before + 1, "{lookup:?}");
    }
}

#[test]
fn test_ascii_input_skips_the_folded_step() {
    for lookup in LOOKUPS {
        let mut fixture = LookupLibrary::new(lookup);
        // NFD turns the Kelvin sign (U+212A) into an ASCII "K", so the
        // simple fold matches "kelvin". The folded step must not run for the
        // ASCII input.
        fixture.add("\u{212A}elvin");
        let before = fixture.stored_count();

        fixture.add("kelvin");

        assert_eq!(fixture.stored_count(), before + 1, "{lookup:?}");
    }
}

#[test]
fn test_simple_fold_keeps_sharp_s_apart() {
    for lookup in LOOKUPS {
        let mut fixture = LookupLibrary::new(lookup);
        fixture.add("Großstraße");
        let before = fixture.stored_count();

        fixture.add("GROSSSTRAẞE");

        assert_eq!(fixture.stored_count(), before + 1, "{lookup:?}");
    }
}
