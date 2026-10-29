// Tests for Library::delete_books — transactional removal of book records.
#[allow(dead_code, unused_imports)]
mod common;

use common::setup_with_library;
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{BigInt, Integer};
use libcalibre::{BookAdd, BookId, CalibreError, Library};
use std::collections::HashMap;
use std::path::Path;

fn book(title: &str) -> BookAdd {
    BookAdd {
        title: title.to_string(),
        author_names: vec!["Ursula K. Le Guin".to_string()],
        tags: Some(vec!["fantasy".to_string()]),
        series: Some("Earthsea".to_string()),
        series_index: Some(1.0),
        publisher: None,
        publication_date: None,
        rating: None,
        comments: None,
        identifiers: HashMap::new(),
        language: None,
        file_paths: vec![],
    }
}

/// Rows in `table` that belong to `book_id`.
fn rows_for_book(lib: &Library, table: &str, book_id: BookId) -> i64 {
    #[derive(QueryableByName)]
    struct CountRow {
        #[diesel(sql_type = BigInt)]
        n: i64,
    }

    let mut conn = libcalibre::persistence::establish_connection(lib.database_path())
        .expect("failed to open test db");
    sql_query(format!("SELECT COUNT(*) AS n FROM {table} WHERE book = ?"))
        .bind::<Integer, _>(book_id.as_i32())
        .get_result::<CountRow>(&mut conn)
        .expect("count query failed")
        .n
}

fn custom_tables_for(lib: &mut Library) -> Vec<String> {
    lib.custom_columns()
        .unwrap()
        .into_iter()
        .map(|column| {
            if column.normalized {
                format!("books_custom_column_{}_link", column.id)
            } else {
                format!("custom_column_{}", column.id)
            }
        })
        .collect()
}

#[test]
fn test_delete_books_removes_all_records_but_leaves_files() {
    let (_temp, mut lib) = setup_with_library();

    let doomed = lib.add_book(book("A Wizard of Earthsea")).unwrap();
    let kept = lib.add_book(book("The Tombs of Atuan")).unwrap();
    // Custom-column values: the `read` bool (non-normalized) and genres
    // (normalized), for both books.
    for id in [doomed.id, kept.id] {
        lib.set_book_read_state(id, true).unwrap();
        lib.set_book_genres(id, vec!["Fantasy".to_string()])
            .unwrap();
        lib.upsert_book_identifier(id, "isbn".to_string(), "9780547773742".to_string(), None)
            .unwrap();
    }

    let doomed_dir = Path::new(lib.library_path()).join(&doomed.book_dir_path);
    std::fs::create_dir_all(&doomed_dir).unwrap();
    std::fs::write(doomed_dir.join("keep-me.txt"), "still here").unwrap();

    let custom_tables = custom_tables_for(&mut lib);
    assert_eq!(custom_tables.len(), 2);
    let tables: Vec<&str> = [
        "books_authors_link",
        "books_tags_link",
        "books_series_link",
        "identifiers",
    ]
    .into_iter()
    .chain(custom_tables.iter().map(String::as_str))
    .collect();
    for table in &tables {
        assert_eq!(rows_for_book(&lib, table, doomed.id), 1, "{table} before");
    }

    let dirs = lib.delete_books(&[doomed.id]).unwrap();

    // delete_books resolves the library root (on macOS, /var is /private/var).
    assert_eq!(dirs, [doomed_dir.canonicalize().unwrap()]);
    for table in &tables {
        assert_eq!(rows_for_book(&lib, table, doomed.id), 0, "{table} after");
        assert_eq!(rows_for_book(&lib, table, kept.id), 1, "{table} kept");
    }
    assert!(matches!(
        lib.get_book(doomed.id),
        Err(CalibreError::BookNotFound(_))
    ));
    assert_eq!(lib.get_book(kept.id).unwrap().title, "The Tombs of Atuan");

    // Files on disk are the caller's job.
    assert!(doomed_dir.join("keep-me.txt").exists());
}

#[test]
fn test_delete_books_is_all_or_nothing() {
    let (_temp, mut lib) = setup_with_library();

    let first = lib.add_book(book("First")).unwrap();
    let second = lib.add_book(book("Second")).unwrap();

    let missing = BookId::from(9_999);
    let error = lib
        .delete_books(&[first.id, missing, second.id])
        .unwrap_err();
    assert!(matches!(error, CalibreError::BookNotFound(id) if id == missing));

    // The first delete rolled back with the failure.
    assert_eq!(lib.books().unwrap().len(), 2);
    assert_eq!(rows_for_book(&lib, "books_tags_link", first.id), 1);
}

#[test]
fn test_delete_books_multiple() {
    let (_temp, mut lib) = setup_with_library();

    let first = lib.add_book(book("First")).unwrap();
    let second = lib.add_book(book("Second")).unwrap();
    lib.add_book(book("Third")).unwrap();

    let dirs = lib.delete_books(&[second.id, first.id]).unwrap();

    assert_eq!(dirs.len(), 2);
    assert!(dirs[0].ends_with(&second.book_dir_path));
    assert!(dirs[1].ends_with(&first.book_dir_path));
    let titles: Vec<String> = lib.books().unwrap().into_iter().map(|b| b.title).collect();
    assert_eq!(titles, ["Third"]);
}

#[test]
fn test_delete_cleans_only_newly_orphaned_entities_and_rolls_back_cleanup() {
    use diesel::sql_types::Text;
    #[derive(QueryableByName)]
    struct NameRow {
        #[diesel(sql_type = Text)]
        name: String,
    }
    let (_temp, mut lib) = setup_with_library();
    let mut doomed = book("Doomed");
    doomed.author_names = vec!["Shared Author".into(), "Only Doomed Author".into()];
    doomed.tags = Some(vec!["Shared Tag".into(), "Only Doomed Tag".into()]);
    doomed.series = Some("Only Doomed Series".into());
    let doomed = lib.add_book(doomed).unwrap();
    let mut kept = book("Kept");
    kept.author_names = vec!["Shared Author".into()];
    kept.tags = Some(vec!["Shared Tag".into()]);
    kept.series = Some("Kept Series".into());
    let kept = lib.add_book(kept).unwrap();
    let mut second_doomed = book("Doomed2");
    second_doomed.series = Some("Kept Series".into());
    let second_doomed = lib.add_book(second_doomed).unwrap();
    let mut conn = libcalibre::persistence::establish_connection(lib.database_path()).unwrap();
    for (name, id) in [
        ("Shared Publisher", doomed.id),
        ("Only Doomed Publisher", second_doomed.id),
    ] {
        sql_query("INSERT INTO publishers(name) VALUES (?)")
            .bind::<Text, _>(name)
            .execute(&mut conn)
            .unwrap();
        sql_query("INSERT INTO books_publishers_link(book,publisher) SELECT ?,id FROM publishers WHERE name=?")
            .bind::<Integer,_>(id.as_i32()).bind::<Text,_>(name).execute(&mut conn).unwrap();
    }
    sql_query("INSERT INTO books_publishers_link(book,publisher) SELECT ?,id FROM publishers WHERE name='Shared Publisher'")
        .bind::<Integer,_>(kept.id.as_i32()).execute(&mut conn).unwrap();
    for table in ["authors", "tags", "series", "publishers"] {
        sql_query(format!(
            "INSERT INTO {table}(name) VALUES ('Previously unused')"
        ))
        .execute(&mut conn)
        .unwrap();
    }
    assert!(lib
        .delete_books(&[doomed.id, second_doomed.id, BookId::from(999999)])
        .is_err());
    for (table, name) in [
        ("authors", "Only Doomed Author"),
        ("tags", "Only Doomed Tag"),
        ("series", "Only Doomed Series"),
        ("publishers", "Only Doomed Publisher"),
    ] {
        let names = sql_query(format!("SELECT name FROM {table}"))
            .load::<NameRow>(&mut conn)
            .unwrap();
        assert!(
            names.iter().any(|row| row.name == name),
            "rollback: {table}"
        );
    }
    lib.delete_books(&[doomed.id, second_doomed.id]).unwrap();
    for (table, shared, removed) in [
        ("authors", "Shared Author", "Only Doomed Author"),
        ("tags", "Shared Tag", "Only Doomed Tag"),
        ("series", "Kept Series", "Only Doomed Series"),
        ("publishers", "Shared Publisher", "Only Doomed Publisher"),
    ] {
        let names = sql_query(format!("SELECT name FROM {table}"))
            .load::<NameRow>(&mut conn)
            .unwrap();
        assert!(
            names.iter().any(|row| row.name == shared),
            "shared: {table}"
        );
        assert!(
            !names.iter().any(|row| row.name == removed),
            "orphan: {table}"
        );
        assert!(
            names.iter().any(|row| row.name == "Previously unused"),
            "unrelated: {table}"
        );
    }
    lib.delete_books(&[kept.id]).unwrap();
    for table in ["authors", "tags", "series", "publishers"] {
        let names = sql_query(format!("SELECT name FROM {table}"))
            .load::<NameRow>(&mut conn)
            .unwrap();
        assert_eq!(names.len(), 1, "last book: {table}");
        assert_eq!(names[0].name, "Previously unused");
    }
}
