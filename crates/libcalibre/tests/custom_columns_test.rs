// Tests for the generic custom-column API.
mod common;

use chrono::{TimeZone, Utc};
use common::{setup_with_library, standard_test_book};
use libcalibre::{
    BookId, BookQuery, CalibreError, CustomColumnKind, CustomColumnSpec, CustomValue, Library,
};

fn spec(label: &str, kind: CustomColumnKind) -> CustomColumnSpec {
    CustomColumnSpec {
        label: label.to_string(),
        name: label.to_string(),
        kind,
        is_multiple: false,
        enum_values: vec![],
        display: None,
    }
}

fn add_book(lib: &mut Library) -> BookId {
    lib.add_book(standard_test_book()).unwrap().id
}

/// Open a second, raw connection to the library's metadata.db.
fn raw_conn(lib: &Library) -> rusqlite::Connection {
    rusqlite::Connection::open(lib.database_path()).unwrap()
}

// =============================================================================
// 1. Round-trips for every supported kind
// =============================================================================

#[test]
fn test_bool_round_trip_and_clear() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);
    let col = lib
        .create_custom_column(spec("finished", CustomColumnKind::Bool))
        .unwrap();

    // No row yet: tri-state "unknown"
    assert_eq!(lib.get_custom_value(book, col.id).unwrap(), None);

    lib.set_custom_value(book, col.id, Some(CustomValue::Bool(true)))
        .unwrap();
    assert_eq!(
        lib.get_custom_value(book, col.id).unwrap(),
        Some(CustomValue::Bool(true))
    );

    lib.set_custom_value(book, col.id, Some(CustomValue::Bool(false)))
        .unwrap();
    assert_eq!(
        lib.get_custom_value(book, col.id).unwrap(),
        Some(CustomValue::Bool(false))
    );

    // Clear back to unknown
    lib.set_custom_value(book, col.id, None).unwrap();
    assert_eq!(lib.get_custom_value(book, col.id).unwrap(), None);
}

#[test]
fn test_int_round_trip() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);
    let col = lib
        .create_custom_column(spec("pages", CustomColumnKind::Int))
        .unwrap();

    lib.set_custom_value(book, col.id, Some(CustomValue::Int(417)))
        .unwrap();
    assert_eq!(
        lib.get_custom_value(book, col.id).unwrap(),
        Some(CustomValue::Int(417))
    );

    lib.set_custom_value(book, col.id, None).unwrap();
    assert_eq!(lib.get_custom_value(book, col.id).unwrap(), None);
}

#[test]
fn test_float_round_trip() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);
    let col = lib
        .create_custom_column(spec("price", CustomColumnKind::Float))
        .unwrap();

    lib.set_custom_value(book, col.id, Some(CustomValue::Float(12.5)))
        .unwrap();
    assert_eq!(
        lib.get_custom_value(book, col.id).unwrap(),
        Some(CustomValue::Float(12.5))
    );
}

#[test]
fn test_text_single_round_trip() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);
    let col = lib
        .create_custom_column(spec("mood", CustomColumnKind::Text))
        .unwrap();
    assert!(col.normalized);

    lib.set_custom_value(book, col.id, Some(CustomValue::Text("cozy".to_string())))
        .unwrap();
    assert_eq!(
        lib.get_custom_value(book, col.id).unwrap(),
        Some(CustomValue::Text("cozy".to_string()))
    );

    // Replace
    lib.set_custom_value(book, col.id, Some(CustomValue::Text("grim".to_string())))
        .unwrap();
    assert_eq!(
        lib.get_custom_value(book, col.id).unwrap(),
        Some(CustomValue::Text("grim".to_string()))
    );

    // Clear
    lib.set_custom_value(book, col.id, None).unwrap();
    assert_eq!(lib.get_custom_value(book, col.id).unwrap(), None);
}

#[test]
fn test_text_multiple_round_trip() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);
    let col = lib
        .create_custom_column(CustomColumnSpec {
            is_multiple: true,
            ..spec("genres", CustomColumnKind::Text)
        })
        .unwrap();
    assert!(col.is_multiple);

    lib.set_custom_value(
        book,
        col.id,
        Some(CustomValue::TextMultiple(vec![
            "fantasy".to_string(),
            "epic".to_string(),
        ])),
    )
    .unwrap();

    let Some(CustomValue::TextMultiple(mut values)) = lib.get_custom_value(book, col.id).unwrap()
    else {
        panic!("expected TextMultiple");
    };
    values.sort();
    assert_eq!(values, vec!["epic".to_string(), "fantasy".to_string()]);

    // Empty list clears
    lib.set_custom_value(book, col.id, Some(CustomValue::TextMultiple(vec![])))
        .unwrap();
    assert_eq!(lib.get_custom_value(book, col.id).unwrap(), None);
}

#[test]
fn test_comments_round_trip() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);
    let col = lib
        .create_custom_column(spec("notes", CustomColumnKind::Comments))
        .unwrap();
    assert!(!col.normalized);

    lib.set_custom_value(
        book,
        col.id,
        Some(CustomValue::Text("<p>Loved it</p>".to_string())),
    )
    .unwrap();
    assert_eq!(
        lib.get_custom_value(book, col.id).unwrap(),
        Some(CustomValue::Text("<p>Loved it</p>".to_string()))
    );
}

#[test]
fn test_datetime_round_trip() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);
    let col = lib
        .create_custom_column(spec("read_on", CustomColumnKind::Datetime))
        .unwrap();

    let dt = Utc.with_ymd_and_hms(2024, 1, 15, 10, 30, 0).unwrap();
    lib.set_custom_value(book, col.id, Some(CustomValue::Datetime(dt)))
        .unwrap();
    assert_eq!(
        lib.get_custom_value(book, col.id).unwrap(),
        Some(CustomValue::Datetime(dt))
    );

    // Stored in Calibre's on-disk format
    let conn = raw_conn(&lib);
    let raw: String = conn
        .query_row(
            &format!("SELECT value FROM custom_column_{} WHERE book = ?1", col.id),
            [book.as_i32()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(raw, "2024-01-15 10:30:00+00:00");
}

#[test]
fn test_enumeration_round_trip() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);
    let col = lib
        .create_custom_column(CustomColumnSpec {
            enum_values: vec![
                "want-to-read".to_string(),
                "reading".to_string(),
                "read".to_string(),
            ],
            ..spec("status", CustomColumnKind::Enumeration)
        })
        .unwrap();
    assert_eq!(col.enum_values, vec!["want-to-read", "reading", "read"]);

    lib.set_custom_value(
        book,
        col.id,
        Some(CustomValue::Enumeration("reading".to_string())),
    )
    .unwrap();
    assert_eq!(
        lib.get_custom_value(book, col.id).unwrap(),
        Some(CustomValue::Enumeration("reading".to_string()))
    );

    // Empty enumeration value clears
    lib.set_custom_value(book, col.id, Some(CustomValue::Enumeration(String::new())))
        .unwrap();
    assert_eq!(lib.get_custom_value(book, col.id).unwrap(), None);
}

#[test]
fn test_batch_get_custom_values() {
    let (_temp, mut lib) = setup_with_library();
    let book1 = add_book(&mut lib);
    let book2 = add_book(&mut lib);
    let book3 = add_book(&mut lib);
    let col = lib
        .create_custom_column(spec("pages", CustomColumnKind::Int))
        .unwrap();

    lib.set_custom_value(book1, col.id, Some(CustomValue::Int(100)))
        .unwrap();
    lib.set_custom_value(book2, col.id, Some(CustomValue::Int(200)))
        .unwrap();

    let values = lib
        .batch_get_custom_values(col.id, &[book1, book2, book3])
        .unwrap();
    assert_eq!(values.len(), 2);
    assert_eq!(values.get(&book1), Some(&CustomValue::Int(100)));
    assert_eq!(values.get(&book2), Some(&CustomValue::Int(200)));
    assert_eq!(values.get(&book3), None);
}

#[test]
fn test_batch_get_custom_values_normalized_kinds() {
    let (_temp, mut lib) = setup_with_library();
    let book1 = add_book(&mut lib);
    let book2 = add_book(&mut lib);
    let book3 = add_book(&mut lib); // never gets any value

    let mood = lib
        .create_custom_column(spec("mood", CustomColumnKind::Text))
        .unwrap();
    let genres = lib
        .create_custom_column(CustomColumnSpec {
            is_multiple: true,
            ..spec("genres", CustomColumnKind::Text)
        })
        .unwrap();
    let status = lib
        .create_custom_column(CustomColumnSpec {
            enum_values: vec!["reading".to_string(), "read".to_string()],
            ..spec("status", CustomColumnKind::Enumeration)
        })
        .unwrap();

    // Single-value text
    lib.set_custom_value(book1, mood.id, Some(CustomValue::Text("cozy".to_string())))
        .unwrap();
    lib.set_custom_value(book2, mood.id, Some(CustomValue::Text("grim".to_string())))
        .unwrap();

    // Multiple text (grouping): two values for book1, one for book2
    lib.set_custom_value(
        book1,
        genres.id,
        Some(CustomValue::TextMultiple(vec![
            "fantasy".to_string(),
            "epic".to_string(),
        ])),
    )
    .unwrap();
    lib.set_custom_value(
        book2,
        genres.id,
        Some(CustomValue::TextMultiple(vec!["noir".to_string()])),
    )
    .unwrap();

    // Enumeration
    lib.set_custom_value(
        book1,
        status.id,
        Some(CustomValue::Enumeration("reading".to_string())),
    )
    .unwrap();
    lib.set_custom_value(
        book2,
        status.id,
        Some(CustomValue::Enumeration("read".to_string())),
    )
    .unwrap();

    let books = [book1, book2, book3];

    let moods = lib.batch_get_custom_values(mood.id, &books).unwrap();
    assert_eq!(moods.len(), 2);
    assert_eq!(
        moods.get(&book1),
        Some(&CustomValue::Text("cozy".to_string()))
    );
    assert_eq!(
        moods.get(&book2),
        Some(&CustomValue::Text("grim".to_string()))
    );
    assert_eq!(moods.get(&book3), None);

    let genre_values = lib.batch_get_custom_values(genres.id, &books).unwrap();
    assert_eq!(genre_values.len(), 2);
    let Some(CustomValue::TextMultiple(mut book1_genres)) = genre_values.get(&book1).cloned()
    else {
        panic!("expected TextMultiple for book1");
    };
    book1_genres.sort();
    assert_eq!(
        book1_genres,
        vec!["epic".to_string(), "fantasy".to_string()]
    );
    assert_eq!(
        genre_values.get(&book2),
        Some(&CustomValue::TextMultiple(vec!["noir".to_string()]))
    );
    assert_eq!(genre_values.get(&book3), None);

    let statuses = lib.batch_get_custom_values(status.id, &books).unwrap();
    assert_eq!(statuses.len(), 2);
    assert_eq!(
        statuses.get(&book1),
        Some(&CustomValue::Enumeration("reading".to_string()))
    );
    assert_eq!(
        statuses.get(&book2),
        Some(&CustomValue::Enumeration("read".to_string()))
    );
    assert_eq!(statuses.get(&book3), None);
}

#[test]
fn test_empty_text_values_clear() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);

    // Single-value text: empty string clears
    let mood = lib
        .create_custom_column(spec("mood", CustomColumnKind::Text))
        .unwrap();
    lib.set_custom_value(book, mood.id, Some(CustomValue::Text("cozy".to_string())))
        .unwrap();
    lib.set_custom_value(book, mood.id, Some(CustomValue::Text(String::new())))
        .unwrap();
    assert_eq!(lib.get_custom_value(book, mood.id).unwrap(), None);

    // Comments: empty string clears
    let notes = lib
        .create_custom_column(spec("notes", CustomColumnKind::Comments))
        .unwrap();
    lib.set_custom_value(book, notes.id, Some(CustomValue::Text("x".to_string())))
        .unwrap();
    lib.set_custom_value(book, notes.id, Some(CustomValue::Text(String::new())))
        .unwrap();
    assert_eq!(lib.get_custom_value(book, notes.id).unwrap(), None);

    // Multiple text: empty entries are filtered out before writing
    let genres = lib
        .create_custom_column(CustomColumnSpec {
            is_multiple: true,
            ..spec("genres", CustomColumnKind::Text)
        })
        .unwrap();
    lib.set_custom_value(
        book,
        genres.id,
        Some(CustomValue::TextMultiple(vec![
            "fantasy".to_string(),
            String::new(),
            "epic".to_string(),
        ])),
    )
    .unwrap();
    let Some(CustomValue::TextMultiple(mut values)) =
        lib.get_custom_value(book, genres.id).unwrap()
    else {
        panic!("expected TextMultiple");
    };
    values.sort();
    assert_eq!(values, vec!["epic".to_string(), "fantasy".to_string()]);

    // All entries empty: clears
    lib.set_custom_value(
        book,
        genres.id,
        Some(CustomValue::TextMultiple(vec![
            String::new(),
            String::new(),
        ])),
    )
    .unwrap();
    assert_eq!(lib.get_custom_value(book, genres.id).unwrap(), None);
}

#[test]
fn test_get_custom_values_for_book_skips_unsupported() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);

    let pages = lib
        .create_custom_column(spec("pages", CustomColumnKind::Int))
        .unwrap();
    let mood = lib
        .create_custom_column(spec("mood", CustomColumnKind::Text))
        .unwrap();
    // Unsupported kind: enumerable but not readable/writable
    let saga = lib
        .create_custom_column(spec("saga", CustomColumnKind::Series))
        .unwrap();

    lib.set_custom_value(book, pages.id, Some(CustomValue::Int(42)))
        .unwrap();
    lib.set_custom_value(book, mood.id, Some(CustomValue::Text("cozy".to_string())))
        .unwrap();

    let values = lib.get_custom_values_for_book(book).unwrap();
    assert_eq!(values.get(&pages.id), Some(&CustomValue::Int(42)));
    assert_eq!(
        values.get(&mood.id),
        Some(&CustomValue::Text("cozy".to_string()))
    );
    assert!(!values.contains_key(&saga.id));
}

// =============================================================================
// 2. "Calibre wrote it, we read it"
// =============================================================================

/// Execute the DDL Calibre emits for a column, verbatim (except for the
/// column number substitution).
fn calibre_normalized_ddl(conn: &rusqlite::Connection, n: i64, dt: &str, s_index: &str) {
    let collate = if dt == "TEXT" { "COLLATE NOCASE" } else { "" };
    conn.execute_batch(&format!(
        r#"CREATE TABLE custom_column_{n}(
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    value {dt} NOT NULL {collate},
    link TEXT NOT NULL DEFAULT "",
    UNIQUE(value));
CREATE INDEX custom_column_{n}_idx ON custom_column_{n} (value {collate});
CREATE TABLE books_custom_column_{n}_link(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book INTEGER NOT NULL,
    value INTEGER NOT NULL,
    {s_index}
    UNIQUE(book, value)
    );
CREATE INDEX books_custom_column_{n}_link_aidx ON books_custom_column_{n}_link (value);
CREATE INDEX books_custom_column_{n}_link_bidx ON books_custom_column_{n}_link (book);
CREATE TRIGGER fkc_update_books_custom_column_{n}_link_a
        BEFORE UPDATE OF book ON books_custom_column_{n}_link
        BEGIN
            SELECT CASE
                WHEN (SELECT id from books WHERE id=NEW.book) IS NULL
                THEN RAISE(ABORT, 'Foreign key violation: book not in books')
            END;
        END;
CREATE TRIGGER fkc_update_books_custom_column_{n}_link_b
        BEFORE UPDATE OF author ON books_custom_column_{n}_link
        BEGIN
            SELECT CASE
                WHEN (SELECT id from custom_column_{n} WHERE id=NEW.value) IS NULL
                THEN RAISE(ABORT, 'Foreign key violation: value not in custom_column_{n}')
            END;
        END;
CREATE TRIGGER fkc_insert_books_custom_column_{n}_link
        BEFORE INSERT ON books_custom_column_{n}_link
        BEGIN
            SELECT CASE
                WHEN (SELECT id from books WHERE id=NEW.book) IS NULL
                THEN RAISE(ABORT, 'Foreign key violation: book not in books')
                WHEN (SELECT id from custom_column_{n} WHERE id=NEW.value) IS NULL
                THEN RAISE(ABORT, 'Foreign key violation: value not in custom_column_{n}')
            END;
        END;
CREATE TRIGGER fkc_delete_books_custom_column_{n}_link
        AFTER DELETE ON custom_column_{n}
        BEGIN
            DELETE FROM books_custom_column_{n}_link WHERE value=OLD.id;
        END;
CREATE VIEW tag_browser_custom_column_{n} AS SELECT
    id,
    value,
    (SELECT COUNT(id) FROM books_custom_column_{n}_link WHERE value=custom_column_{n}.id) count,
    (SELECT AVG(r.rating)
     FROM books_custom_column_{n}_link,
          books_ratings_link as bl,
          ratings as r
     WHERE books_custom_column_{n}_link.value=custom_column_{n}.id and bl.book=books_custom_column_{n}_link.book and
           r.id = bl.rating and r.rating <> 0) avg_rating,
    value AS sort
FROM custom_column_{n};
CREATE VIEW tag_browser_filtered_custom_column_{n} AS SELECT
    id,
    value,
    (SELECT COUNT(books_custom_column_{n}_link.id) FROM books_custom_column_{n}_link WHERE value=custom_column_{n}.id AND
    books_list_filter(book)) count,
    (SELECT AVG(r.rating)
     FROM books_custom_column_{n}_link,
          books_ratings_link as bl,
          ratings as r
     WHERE books_custom_column_{n}_link.value=custom_column_{n}.id AND bl.book=books_custom_column_{n}_link.book AND
           r.id = bl.rating AND r.rating <> 0 AND
           books_list_filter(bl.book)) avg_rating,
    value AS sort
FROM custom_column_{n};
"#
    ))
    .unwrap();
}

fn calibre_non_normalized_ddl(conn: &rusqlite::Connection, n: i64, dt: &str) {
    let collate = if dt == "TEXT" { "COLLATE NOCASE" } else { "" };
    conn.execute_batch(&format!(
        r#"CREATE TABLE custom_column_{n}(
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    book  INTEGER,
    value {dt} NOT NULL {collate},
    UNIQUE(book));
CREATE INDEX custom_column_{n}_idx ON custom_column_{n} (book);
CREATE TRIGGER fkc_insert_custom_column_{n}
        BEFORE INSERT ON custom_column_{n}
        BEGIN
            SELECT CASE
                WHEN (SELECT id from books WHERE id=NEW.book) IS NULL
                THEN RAISE(ABORT, 'Foreign key violation: book not in books')
            END;
        END;
CREATE TRIGGER fkc_update_custom_column_{n}
        BEFORE UPDATE OF book ON custom_column_{n}
        BEGIN
            SELECT CASE
                WHEN (SELECT id from books WHERE id=NEW.book) IS NULL
                THEN RAISE(ABORT, 'Foreign key violation: book not in books')
            END;
        END;
"#
    ))
    .unwrap();
}

fn insert_custom_columns_row(
    conn: &rusqlite::Connection,
    label: &str,
    name: &str,
    datatype: &str,
    is_multiple: bool,
    normalized: bool,
    display: &str,
) -> i64 {
    conn.execute(
        "INSERT INTO custom_columns (label, name, datatype, mark_for_delete, editable, display, is_multiple, normalized)
         VALUES (?1, ?2, ?3, 0, 1, ?4, ?5, ?6)",
        rusqlite::params![label, name, datatype, display, is_multiple, normalized],
    )
    .unwrap();
    conn.last_insert_rowid()
}

#[test]
fn test_calibre_created_columns_are_read_correctly() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib); // also creates the `read` column (id 1)

    let conn = raw_conn(&lib);

    // Enumeration column, as Calibre creates it
    let status_id = insert_custom_columns_row(
        &conn,
        "status",
        "Status",
        "enumeration",
        false,
        true,
        r#"{"enum_values": ["want-to-read", "reading", "read"], "enum_colors": []}"#,
    );
    calibre_normalized_ddl(&conn, status_id, "TEXT", "");
    conn.execute(
        &format!("INSERT INTO custom_column_{status_id} (value, link) VALUES ('reading', '')"),
        [],
    )
    .unwrap();
    conn.execute(
        &format!(
            "INSERT INTO books_custom_column_{status_id}_link (book, value)
             VALUES (?1, (SELECT id FROM custom_column_{status_id} WHERE value = 'reading'))"
        ),
        [book.as_i32()],
    )
    .unwrap();

    // Multiple-text column with two link rows
    let genres_id = insert_custom_columns_row(
        &conn,
        "genres",
        "Genres",
        "text",
        true,
        true,
        r#"{"is_names": false, "description": ""}"#,
    );
    calibre_normalized_ddl(&conn, genres_id, "TEXT", "");
    for value in ["fantasy", "epic"] {
        conn.execute(
            &format!("INSERT INTO custom_column_{genres_id} (value, link) VALUES (?1, '')"),
            [value],
        )
        .unwrap();
        conn.execute(
            &format!(
                "INSERT INTO books_custom_column_{genres_id}_link (book, value)
                 VALUES (?1, (SELECT id FROM custom_column_{genres_id} WHERE value = ?2))"
            ),
            rusqlite::params![book.as_i32(), value],
        )
        .unwrap();
    }

    // Datetime column, with a fractional-seconds value
    let released_id = insert_custom_columns_row(
        &conn, "released", "Released", "datetime", false, false, "{}",
    );
    calibre_non_normalized_ddl(&conn, released_id, "timestamp");
    conn.execute(
        &format!(
            "INSERT INTO custom_column_{released_id} (book, value)
             VALUES (?1, '2024-03-02T08:15:30.123456+00:00')"
        ),
        [book.as_i32()],
    )
    .unwrap();
    drop(conn);

    // Enumerate
    let columns = lib.custom_columns().unwrap();
    let status = columns.iter().find(|c| c.label == "status").unwrap();
    assert_eq!(status.kind, CustomColumnKind::Enumeration);
    assert!(status.normalized);
    assert_eq!(status.enum_values, vec!["want-to-read", "reading", "read"]);

    let genres = columns.iter().find(|c| c.label == "genres").unwrap();
    assert_eq!(genres.kind, CustomColumnKind::Text);
    assert!(genres.is_multiple);

    let released = columns.iter().find(|c| c.label == "released").unwrap();
    assert_eq!(released.kind, CustomColumnKind::Datetime);
    assert!(!released.normalized);

    // Read the Calibre-seeded values
    assert_eq!(
        lib.get_custom_value(book, status.id).unwrap(),
        Some(CustomValue::Enumeration("reading".to_string()))
    );

    let Some(CustomValue::TextMultiple(mut genre_values)) =
        lib.get_custom_value(book, genres.id).unwrap()
    else {
        panic!("expected TextMultiple");
    };
    genre_values.sort();
    assert_eq!(
        genre_values,
        vec!["epic".to_string(), "fantasy".to_string()]
    );

    let expected = Utc.with_ymd_and_hms(2024, 3, 2, 8, 15, 30).unwrap()
        + chrono::Duration::microseconds(123456);
    assert_eq!(
        lib.get_custom_value(book, released.id).unwrap(),
        Some(CustomValue::Datetime(expected))
    );
}

// =============================================================================
// 3. "We wrote it, Calibre reads it" (raw table contents)
// =============================================================================

#[test]
fn test_written_values_match_calibre_raw_format() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);

    // Normalized text: value row + link row
    let mood = lib
        .create_custom_column(spec("mood", CustomColumnKind::Text))
        .unwrap();
    lib.set_custom_value(book, mood.id, Some(CustomValue::Text("cozy".to_string())))
        .unwrap();

    {
        let conn = raw_conn(&lib);
        let n = mood.id;
        let (value_id, value): (i64, String) = conn
            .query_row(
                &format!("SELECT id, value FROM custom_column_{n}"),
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(value, "cozy");

        let (link_book, link_value): (i64, i64) = conn
            .query_row(
                &format!("SELECT book, value FROM books_custom_column_{n}_link"),
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(link_book, book.as_i32() as i64);
        assert_eq!(link_value, value_id);
    }

    // Replacing prunes the orphaned value row
    lib.set_custom_value(book, mood.id, Some(CustomValue::Text("grim".to_string())))
        .unwrap();
    {
        let conn = raw_conn(&lib);
        let n = mood.id;
        let values: Vec<String> = conn
            .prepare(&format!("SELECT value FROM custom_column_{n}"))
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(values, vec!["grim".to_string()]);
    }

    // Non-normalized bool: (book, value) row
    let finished = lib
        .create_custom_column(spec("finished", CustomColumnKind::Bool))
        .unwrap();
    lib.set_custom_value(book, finished.id, Some(CustomValue::Bool(true)))
        .unwrap();
    {
        let conn = raw_conn(&lib);
        let n = finished.id;
        let (row_book, row_value): (i64, i64) = conn
            .query_row(
                &format!("SELECT book, value FROM custom_column_{n}"),
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row_book, book.as_i32() as i64);
        assert_eq!(row_value, 1);

        // Table shape matches Calibre: book column with no NOT NULL, BOOL value
        let create_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [format!("custom_column_{n}")],
                |row| row.get(0),
            )
            .unwrap();
        assert!(create_sql.contains("AUTOINCREMENT"), "{create_sql}");
        assert!(create_sql.contains("UNIQUE(book)"), "{create_sql}");
    }

    // Case-insensitive value reuse: a second book setting "COZY"... must not
    // violate the COLLATE NOCASE UNIQUE constraint.
    let book2 = add_book(&mut lib);
    lib.set_custom_value(book, mood.id, Some(CustomValue::Text("cozy".to_string())))
        .unwrap();
    lib.set_custom_value(book2, mood.id, Some(CustomValue::Text("COZY".to_string())))
        .unwrap();
    {
        let conn = raw_conn(&lib);
        let n = mood.id;
        let value_count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM custom_column_{n}"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value_count, 1, "case-insensitive match must reuse the row");
        let link_count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM books_custom_column_{n}_link"),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(link_count, 2);
    }
}

#[test]
fn test_legacy_citadel_read_table_still_works() {
    let (_temp, mut lib) = setup_with_library();

    // Simulate the table shape older Citadel versions created for `read`,
    // BEFORE any library call auto-creates the new-style column.
    let conn = raw_conn(&lib);
    let n = insert_custom_columns_row(&conn, "read", "Read", "bool", false, false, "{}");
    conn.execute(
        &format!(
            "CREATE TABLE custom_column_{n} \
             (id INTEGER PRIMARY KEY, book INTEGER NOT NULL UNIQUE, value INTEGER NOT NULL)"
        ),
        [],
    )
    .unwrap();
    drop(conn);

    let book = add_book(&mut lib);
    assert!(!lib.get_book_read_state(book).unwrap());
    lib.set_book_read_state(book, true).unwrap();
    assert!(lib.get_book_read_state(book).unwrap());
    assert_eq!(
        lib.batch_get_read_states(&[book]).unwrap().get(&book),
        Some(&true)
    );

    // No duplicate `read` column was created
    let read_columns = lib
        .custom_columns()
        .unwrap()
        .into_iter()
        .filter(|c| c.label == "read")
        .count();
    assert_eq!(read_columns, 1);
}

// =============================================================================
// 4 & 5. Validation errors
// =============================================================================

#[test]
fn test_enumeration_rejects_unknown_value() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);
    let col = lib
        .create_custom_column(CustomColumnSpec {
            enum_values: vec!["yes".to_string(), "no".to_string()],
            ..spec("verdict", CustomColumnKind::Enumeration)
        })
        .unwrap();

    let result = lib.set_custom_value(
        book,
        col.id,
        Some(CustomValue::Enumeration("maybe".to_string())),
    );
    assert!(matches!(result, Err(CalibreError::InvalidCustomValue(_))));
    assert_eq!(lib.get_custom_value(book, col.id).unwrap(), None);
}

#[test]
fn test_type_mismatch_errors() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);

    let flag = lib
        .create_custom_column(spec("flag", CustomColumnKind::Bool))
        .unwrap();
    let result = lib.set_custom_value(book, flag.id, Some(CustomValue::Text("yes".to_string())));
    assert!(matches!(result, Err(CalibreError::InvalidCustomValue(_))));

    // Single text column rejects TextMultiple, and vice versa
    let mood = lib
        .create_custom_column(spec("mood", CustomColumnKind::Text))
        .unwrap();
    let result = lib.set_custom_value(
        book,
        mood.id,
        Some(CustomValue::TextMultiple(vec!["a".to_string()])),
    );
    assert!(matches!(result, Err(CalibreError::InvalidCustomValue(_))));

    let genres = lib
        .create_custom_column(CustomColumnSpec {
            is_multiple: true,
            ..spec("genres", CustomColumnKind::Text)
        })
        .unwrap();
    let result = lib.set_custom_value(book, genres.id, Some(CustomValue::Text("a".to_string())));
    assert!(matches!(result, Err(CalibreError::InvalidCustomValue(_))));
}

#[test]
fn test_unsupported_kinds_enumerate_but_reject_get_set() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);

    let saga = lib
        .create_custom_column(spec("saga", CustomColumnKind::Series))
        .unwrap();
    assert_eq!(saga.kind, CustomColumnKind::Series);
    assert!(saga.normalized);

    let stars = lib
        .create_custom_column(spec("stars", CustomColumnKind::Rating))
        .unwrap();
    assert_eq!(stars.kind, CustomColumnKind::Rating);

    let listed: Vec<String> = lib
        .custom_columns()
        .unwrap()
        .into_iter()
        .map(|c| c.label)
        .collect();
    assert!(listed.contains(&"saga".to_string()));
    assert!(listed.contains(&"stars".to_string()));

    assert!(matches!(
        lib.get_custom_value(book, saga.id),
        Err(CalibreError::UnsupportedCustomColumn(_))
    ));
    assert!(matches!(
        lib.set_custom_value(book, saga.id, Some(CustomValue::Text("x".to_string()))),
        Err(CalibreError::UnsupportedCustomColumn(_))
    ));
    assert!(matches!(
        lib.batch_get_custom_values(stars.id, &[book]),
        Err(CalibreError::UnsupportedCustomColumn(_))
    ));
}

#[test]
fn test_create_rejects_invalid_specs() {
    let (_temp, mut lib) = setup_with_library();

    // Bad labels
    for bad_label in ["1pages", "_pages", "pa-ges", "pa ges", ""] {
        let result = lib.create_custom_column(spec(bad_label, CustomColumnKind::Int));
        assert!(
            matches!(result, Err(CalibreError::InvalidCustomColumn(_))),
            "label {bad_label:?} should be rejected"
        );
    }

    // Uppercase labels are lowercased, like Calibre does
    let col = lib
        .create_custom_column(spec("Pages", CustomColumnKind::Int))
        .unwrap();
    assert_eq!(col.label, "pages");

    // is_multiple only for text
    let result = lib.create_custom_column(CustomColumnSpec {
        is_multiple: true,
        ..spec("counts", CustomColumnKind::Int)
    });
    assert!(matches!(result, Err(CalibreError::InvalidCustomColumn(_))));
}

// =============================================================================
// 6. Read-state regression (on top of the generic API)
// =============================================================================

#[test]
fn test_read_state_uses_bool_custom_column() {
    let (_temp, mut lib) = setup_with_library();
    let book1 = add_book(&mut lib);
    let book2 = add_book(&mut lib);

    // Missing value maps to false
    assert!(!lib.get_book_read_state(book1).unwrap());

    lib.set_book_read_state(book1, true).unwrap();
    assert!(lib.get_book_read_state(book1).unwrap());

    let states = lib.batch_get_read_states(&[book1, book2]).unwrap();
    assert_eq!(states.get(&book1), Some(&true));
    // book2 never had its state set: no row at all
    assert_eq!(states.get(&book2), None);

    lib.set_book_read_state(book1, false).unwrap();
    assert!(!lib.get_book_read_state(book1).unwrap());
    // Explicit false is stored as a row (Calibre tri-state "no")
    let states = lib.batch_get_read_states(&[book1]).unwrap();
    assert_eq!(states.get(&book1), Some(&false));

    // The column itself is a proper bool custom column
    let columns = lib.custom_columns().unwrap();
    let read = columns.iter().find(|c| c.label == "read").unwrap();
    assert_eq!(read.kind, CustomColumnKind::Bool);
    assert!(!read.is_multiple);
    assert!(!read.normalized);

    // And it is reachable through the generic value API
    lib.set_book_read_state(book1, true).unwrap();
    assert_eq!(
        lib.get_custom_value(book1, read.id).unwrap(),
        Some(CustomValue::Bool(true))
    );
}

#[test]
fn test_read_state_uses_the_configured_column() {
    let (_temp, lib) = setup_with_library();
    let mut lib = lib.with_read_column("finished");
    let book = add_book(&mut lib);

    lib.set_book_read_state(book, true).unwrap();

    let columns = lib.custom_columns().unwrap();
    let finished = columns.iter().find(|c| c.label == "finished").unwrap();
    assert_eq!(finished.kind, CustomColumnKind::Bool);
    assert_eq!(finished.name, "Finished");
    assert!(!columns.iter().any(|c| c.label == "read"));
    assert!(lib.get_book(book).unwrap().is_read);
    let unread = lib
        .query_books(BookQuery {
            hide_read: true,
            ..BookQuery::default()
        })
        .unwrap();
    assert_eq!(unread.total, 0);
}

#[test]
fn test_without_a_read_column_books_are_unread_and_writes_fail() {
    let (_temp, lib) = setup_with_library();
    let mut lib = lib.with_read_column("read");
    let book = add_book(&mut lib);
    lib.set_book_read_state(book, true).unwrap();
    let mut lib = lib.without_read_column();

    assert_eq!(lib.read_column(), None);
    assert!(!lib.get_book_read_state(book).unwrap());
    assert!(!lib.get_book(book).unwrap().is_read);
    let page = lib
        .query_books(BookQuery {
            hide_read: true,
            ..BookQuery::default()
        })
        .unwrap();
    assert_eq!(page.total, 1);
    assert!(matches!(
        lib.set_book_read_state(book, false),
        Err(CalibreError::NoReadColumn)
    ));
}
