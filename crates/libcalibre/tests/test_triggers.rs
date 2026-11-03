// Tests for database triggers that maintain data integrity
// These triggers match Calibre's behavior for auto-generating fields and cascade deletes

mod common;

use common::{setup_with_library, standard_test_book};
use libcalibre::BookAdd;
use std::collections::HashMap;

/// Test that the books_insert_trg trigger auto-generates sort and uuid fields
#[test]
fn test_books_insert_trigger_generates_sort_and_uuid() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            title: "The Great Gatsby".to_string(),
            author_names: vec!["F. Scott Fitzgerald".to_string()],
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
        })
        .unwrap();

    // Verify sort field was generated (moving "The" to the end)
    assert_eq!(book.sortable_title, Some("Great Gatsby, The".to_string()));

    // Verify UUID was generated (should be a valid UUID format)
    let uuid = book
        .uuid
        .as_deref()
        .expect("insert trigger should set UUID");
    assert_eq!(uuid.len(), 36); // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    assert!(uuid.contains('-'));
}

/// Test that the books_update_trg trigger updates sort when title changes
#[test]
fn test_books_update_trigger_updates_sort() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            title: "Original Title".to_string(),
            author_names: vec![],
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
        })
        .unwrap();

    // Verify initial sort
    assert_eq!(book.sortable_title, Some("Original Title".to_string()));

    // Update the title
    let updated_book = lib
        .update_book(
            book.id,
            libcalibre::BookUpdate {
                title: Some("The New Title".to_string()),
                author_names: None,
                author_ids: None,
                description: None,
                is_read: None,
                tags: None,
                series: None,
                series_index: None,
                language_codes: None,
                publisher: None,
                publication_date: None,
                rating: None,
                comments: None,
                identifiers: None,
            },
        )
        .unwrap();

    // Verify sort was updated by trigger (moving "The" to the end)
    assert_eq!(
        updated_book.sortable_title,
        Some("New Title, The".to_string())
    );
}

/// Test that the insert trigger calls title_sort()
#[test]
fn test_insert_trigger_calls_title_sort() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            title: "The Matrix".to_string(),
            author_names: vec!["Author".to_string()],
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
        })
        .unwrap();

    // Verify trigger invoked title_sort (article moved to end)
    assert_eq!(book.sortable_title, Some("Matrix, The".to_string()));
}

/// Deleting a book clears everything Calibre's own trigger clears, including
/// reading positions and annotations, which exist at every supported schema.
#[test]
fn test_books_delete_trigger_cascades() {
    let (_temp, mut lib) = setup_with_library();
    let book = lib.add_book(standard_test_book()).unwrap();
    let kept = lib.add_book(standard_test_book()).unwrap();
    let conn = rusqlite::Connection::open(lib.database_path()).unwrap();
    for id in [book.id.0, kept.id.0] {
        conn.execute(
            "INSERT INTO last_read_positions (book, format, user, device, cfi, epoch, pos_frac)
             VALUES (?1, 'EPUB', 'phil', 'reader', 'epubcfi(/6/2)', 1.0, 0.5)",
            [id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO annotations (book, format, user_type, user, timestamp, annot_id, annot_type, annot_data, searchable_text)
             VALUES (?1, 'EPUB', 'local', 'phil', 1.0, 'a1', 'highlight', '{}', 'a highlighted phrase')",
            [id],
        )
        .unwrap();
    }
    drop(conn);
    lib.delete_books(&[book.id]).unwrap();
    let conn = rusqlite::Connection::open(lib.database_path()).unwrap();
    let count = |table: &str| -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
    };
    assert_eq!(count("last_read_positions"), 1);
    assert_eq!(count("annotations"), 1);
    let searchable: i64 = conn
        .query_row(
            "SELECT count(*) FROM annotations_fts WHERE annotations_fts MATCH 'highlighted'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        searchable, 1,
        "the FTS index follows the deleted annotation"
    );
}
