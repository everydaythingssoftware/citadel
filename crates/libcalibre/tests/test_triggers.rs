// Tests for database triggers that maintain data integrity
// These triggers match Calibre's behavior for auto-generating fields and cascade deletes

mod common;

use common::setup_with_library;
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

#[test]
#[ignore]
fn test_books_delete_trigger_cascades() {
    // TODO: Implement cascade delete test
    todo!("Implement cascade delete test when delete API is verified")
}
