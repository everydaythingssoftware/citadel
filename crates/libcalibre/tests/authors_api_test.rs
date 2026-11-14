mod common;

use common::setup_with_library;
use libcalibre::{AuthorAdd, AuthorId, BookAdd};
use std::collections::HashMap;

#[test]
fn test_list_authors_empty() {
    let (_temp, mut lib) = setup_with_library();

    let result = lib.authors();
    assert!(result.is_ok());
    assert_eq!(result.unwrap().len(), 0);
}

#[test]
fn test_list_authors_with_data() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_author(AuthorAdd {
        name: "Author One".to_string(),
        sort: Some("One, Author".to_string()),
        link: None,
    })
    .unwrap();

    lib.add_author(AuthorAdd {
        name: "Author Two".to_string(),
        sort: Some("Two, Author".to_string()),
        link: None,
    })
    .unwrap();

    let result = lib.authors();
    assert!(result.is_ok());
    assert_eq!(result.unwrap().len(), 2);
}

#[test]
fn test_find_by_id_exists() {
    let (_temp, mut lib) = setup_with_library();

    let author_id = lib
        .add_author(AuthorAdd {
            name: "Test Author".to_string(),
            sort: Some("Author, Test".to_string()),
            link: None,
        })
        .unwrap();

    let result = lib.get_author(author_id);
    assert!(result.is_ok());
    let found = result.unwrap();
    assert_eq!(found.name, "Test Author");
}

#[test]
fn test_find_by_id_not_found() {
    let (_temp, mut lib) = setup_with_library();

    let result = lib.get_author(AuthorId::from(9999));
    assert!(result.is_err());
}

#[test]
fn test_update_author() {
    let (_temp, mut lib) = setup_with_library();

    let author_id = lib
        .add_author(AuthorAdd {
            name: "Original Name".to_string(),
            sort: Some("Name, Original".to_string()),
            link: None,
        })
        .unwrap();

    let result = lib.update_author(
        author_id,
        libcalibre::AuthorUpdate {
            name: Some("Updated Name".to_string()),
            sort: Some("Name, Updated".to_string()),
            link: Some("https://example.com".to_string()),
        },
    );

    assert!(result.is_ok());
    let updated = result.unwrap();
    assert_eq!(updated.name, "Updated Name");
    assert_eq!(updated.sort, "Name, Updated");
    assert_eq!(updated.link, Some("https://example.com".to_string()));
}

#[test]
fn test_update_nonexistent_author() {
    let (_temp, mut lib) = setup_with_library();

    let result = lib.update_author(
        AuthorId::from(9999),
        libcalibre::AuthorUpdate {
            name: Some("Test".to_string()),
            sort: None,
            link: None,
        },
    );

    assert!(result.is_err());
}

#[test]
fn test_delete_author_without_books() {
    let (_temp, mut lib) = setup_with_library();

    let author_id = lib
        .add_author(AuthorAdd {
            name: "To Delete".to_string(),
            sort: Some("Delete, To".to_string()),
            link: None,
        })
        .unwrap();

    let result = lib.remove_author(author_id);
    assert!(result.is_ok());

    // Verify it's deleted
    let find_result = lib.get_author(author_id);
    assert!(find_result.is_err());
}

#[test]
fn test_delete_author_with_books_fails() {
    let (_temp, mut lib) = setup_with_library();

    // Create a book with an author (add_book creates the author)
    lib.add_book(BookAdd {
        title: "Test Book".to_string(),
        author_names: vec!["Book Author".to_string()],
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
    })
    .unwrap();

    // Find the author
    let authors = lib.authors().unwrap();
    let author = authors.iter().find(|a| a.name == "Book Author").unwrap();

    // Try to delete - should fail because author has books
    let result = lib.remove_author(author.id);
    assert!(result.is_err());
}

#[test]
fn test_author_book_counts_empty_library() {
    let (_temp, mut lib) = setup_with_library();

    let counts = lib.author_book_counts().unwrap();
    assert!(counts.is_empty());
}

#[test]
fn test_author_book_counts_groups_links_per_author() {
    let (_temp, mut lib) = setup_with_library();

    let bookless_author_id = lib
        .add_author(AuthorAdd {
            name: "No Books".to_string(),
            sort: Some("Books, No".to_string()),
            link: None,
        })
        .unwrap();

    let book = |title: &str, author_names: Vec<&str>| BookAdd {
        title: title.to_string(),
        author_names: author_names.into_iter().map(String::from).collect(),
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
    };

    lib.add_book(book("Solo Work", vec!["Author A"])).unwrap();
    lib.add_book(book("Another Solo Work", vec!["Author A"]))
        .unwrap();
    lib.add_book(book("Co-Written Work", vec!["Author A", "Author B"]))
        .unwrap();

    let authors = lib.authors().unwrap();
    let id_of = |name: &str| authors.iter().find(|a| a.name == name).unwrap().id;

    let counts = lib.author_book_counts().unwrap();
    assert_eq!(counts.get(&id_of("Author A")), Some(&3));
    assert_eq!(counts.get(&id_of("Author B")), Some(&1));
    // Authors with no linked books are absent, not present-with-zero.
    assert!(!counts.contains_key(&bookless_author_id));
}
