// Tests for Library book API methods
mod common;

use common::setup_with_library;
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::BigInt;
use libcalibre::{AuthorAdd, BookAdd, BookId, BookUpdate};
use std::collections::HashMap;

fn empty_book(title: &str) -> BookAdd {
    BookAdd {
        title: title.to_string(),
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
    }
}

fn empty_update() -> BookUpdate {
    BookUpdate {
        title: None,
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
    }
}

#[test]
fn test_add_book() {
    let (_temp, mut lib) = setup_with_library();

    let result = lib.add_book(empty_book("Test Book"));
    assert!(result.is_ok());

    let book = result.unwrap();
    assert_eq!(book.title, "Test Book");
    assert!(book.uuid.as_deref().is_some_and(|uuid| !uuid.is_empty()));
}

#[test]
fn test_add_book_canonicalizes_and_persists_language() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            language: Some("fr".to_string()),
            ..empty_book("Le Petit Prince")
        })
        .unwrap();

    // ISO 639-1 "fr" is canonicalized to Calibre's 639-3 "fra".
    assert_eq!(book.language_codes, vec!["fra".to_string()]);

    // Re-reading from the DB yields the same code (hydration, not just add).
    let reloaded = lib.get_book(book.id).unwrap();
    assert_eq!(reloaded.language_codes, vec!["fra".to_string()]);
}

#[test]
fn test_update_book_language_replace_clear_and_untouched() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            language: Some("en".to_string()),
            ..empty_book("Babel")
        })
        .unwrap();
    assert_eq!(book.language_codes, vec!["eng".to_string()]);

    // Replace with two languages, canonicalized and order-preserved.
    let updated = lib
        .update_book(
            book.id,
            BookUpdate {
                language_codes: Some(vec!["fr".to_string(), "de".to_string()]),
                ..empty_update()
            },
        )
        .unwrap();
    assert_eq!(
        updated.language_codes,
        vec!["fra".to_string(), "deu".to_string()]
    );

    // None leaves the languages untouched.
    let untouched = lib
        .update_book(
            book.id,
            BookUpdate {
                title: Some("Babel: A Novel".to_string()),
                ..empty_update()
            },
        )
        .unwrap();
    assert_eq!(
        untouched.language_codes,
        vec!["fra".to_string(), "deu".to_string()]
    );

    // An empty list clears all language links.
    let cleared = lib
        .update_book(
            book.id,
            BookUpdate {
                language_codes: Some(vec![]),
                ..empty_update()
            },
        )
        .unwrap();
    assert!(cleared.language_codes.is_empty());
}

#[test]
fn test_metadata_opf_emits_language_codes() {
    let (_temp, mut lib) = setup_with_library();
    let library_path = lib.library_path().to_string();

    let book = lib
        .add_book(BookAdd {
            language: Some("es".to_string()),
            ..empty_book("Cien años de soledad")
        })
        .unwrap();

    let opf_path = std::path::Path::new(&library_path)
        .join(&book.book_dir_path)
        .join("metadata.opf");
    let opf = std::fs::read_to_string(&opf_path).expect("metadata.opf written on add");
    assert!(
        opf.contains("<dc:language>spa</dc:language>"),
        "OPF should emit the actual language code, got:\n{opf}"
    );
    assert!(!opf.contains("<dc:language>en</dc:language>"));

    // Editing the language regenerates the OPF from DB state.
    lib.update_book(
        book.id,
        BookUpdate {
            language_codes: Some(vec!["ja".to_string()]),
            ..empty_update()
        },
    )
    .unwrap();
    let opf = std::fs::read_to_string(&opf_path).expect("metadata.opf rewritten on update");
    assert!(opf.contains("<dc:language>jpn</dc:language>"));
    assert!(!opf.contains("<dc:language>spa</dc:language>"));
}

#[test]
fn test_list_books_empty() {
    let (_temp, mut lib) = setup_with_library();

    let result = lib.books();
    assert!(result.is_ok());
    assert_eq!(result.unwrap().len(), 0);
}

#[test]
fn test_list_books_with_data() {
    let (_temp, mut lib) = setup_with_library();

    lib.add_book(empty_book("Book 1")).unwrap();
    lib.add_book(empty_book("Book 2")).unwrap();

    let result = lib.books();
    assert!(result.is_ok());
    assert_eq!(result.unwrap().len(), 2);
}

#[test]
fn test_get_book_exists() {
    let (_temp, mut lib) = setup_with_library();

    let created = lib.add_book(empty_book("Findable Book")).unwrap();

    let result = lib.get_book(created.id);
    assert!(result.is_ok());
    assert_eq!(result.unwrap().title, "Findable Book");
}

#[test]
fn test_get_book_not_exists() {
    let (_temp, mut lib) = setup_with_library();

    let result = lib.get_book(BookId::from(9999));
    assert!(result.is_err());
}

#[test]
fn test_update_book_title() {
    let (_temp, mut lib) = setup_with_library();

    let created = lib.add_book(empty_book("Original Title")).unwrap();

    let result = lib.update_book(
        created.id,
        BookUpdate {
            title: Some("Updated Title".to_string()),
            ..empty_update()
        },
    );
    assert!(result.is_ok());
    assert_eq!(result.unwrap().title, "Updated Title");
}

#[test]
fn test_update_nonexistent_book() {
    let (_temp, mut lib) = setup_with_library();

    let result = lib.update_book(
        BookId::from(9999),
        BookUpdate {
            title: Some("Test".to_string()),
            ..empty_update()
        },
    );
    assert!(result.is_err());
}

#[test]
fn test_update_book_authors_by_id() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib.add_book(empty_book("Test Book")).unwrap();

    // Create authors
    let author1_id = lib
        .add_author(AuthorAdd {
            name: "Author One".to_string(),
            sort: Some("One, Author".to_string()),
            link: None,
        })
        .unwrap();

    let author2_id = lib
        .add_author(AuthorAdd {
            name: "Author Two".to_string(),
            sort: Some("Two, Author".to_string()),
            link: None,
        })
        .unwrap();

    // Link authors to book via update
    let updated = lib
        .update_book(
            book.id,
            BookUpdate {
                author_ids: Some(vec![author1_id, author2_id]),
                ..empty_update()
            },
        )
        .unwrap();

    assert_eq!(updated.authors.len(), 2);
}

#[test]
fn test_update_book_description() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib.add_book(empty_book("Test Book")).unwrap();
    assert!(book.description.is_none());

    let updated = lib
        .update_book(
            book.id,
            BookUpdate {
                description: Some("A great book.".to_string()),
                ..empty_update()
            },
        )
        .unwrap();
    assert_eq!(updated.description, Some("A great book.".to_string()));

    // Verify via get_book
    let fetched = lib.get_book(book.id).unwrap();
    assert_eq!(fetched.description, Some("A great book.".to_string()));
}

#[test]
fn test_update_book_read_state() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib.add_book(empty_book("Test Book")).unwrap();
    assert!(!book.is_read);

    // Mark as read
    let updated = lib
        .update_book(
            book.id,
            BookUpdate {
                is_read: Some(true),
                ..empty_update()
            },
        )
        .unwrap();
    assert!(updated.is_read);

    // Verify via get_book
    let fetched = lib.get_book(book.id).unwrap();
    assert!(fetched.is_read);

    // Mark as unread
    let updated = lib
        .update_book(
            book.id,
            BookUpdate {
                is_read: Some(false),
                ..empty_update()
            },
        )
        .unwrap();
    assert!(!updated.is_read);
}

#[test]
fn test_upsert_book_identifier_create() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib.add_book(empty_book("Test Book")).unwrap();

    let result = lib.upsert_book_identifier(
        book.id,
        "ISBN".to_string(),
        "978-0-123456-78-9".to_string(),
        None,
    );
    assert!(result.is_ok());

    // Verify via get_book
    let fetched = lib.get_book(book.id).unwrap();
    assert_eq!(fetched.identifiers.len(), 1);
    assert_eq!(fetched.identifiers[0].label, "isbn"); // Calibre stores labels lowercase
    assert_eq!(fetched.identifiers[0].value, "978-0-123456-78-9");
}

#[test]
fn test_upsert_book_identifier_update() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib.add_book(empty_book("Test Book")).unwrap();

    // Create
    lib.upsert_book_identifier(
        book.id,
        "ISBN".to_string(),
        "978-0-123456-78-9".to_string(),
        None,
    )
    .unwrap();

    let fetched = lib.get_book(book.id).unwrap();
    let identifier_id = fetched.identifiers[0].id;

    // Update
    lib.upsert_book_identifier(
        book.id,
        "ISBN".to_string(),
        "978-0-987654-32-1".to_string(),
        Some(identifier_id),
    )
    .unwrap();

    let fetched = lib.get_book(book.id).unwrap();
    assert_eq!(fetched.identifiers.len(), 1);
    assert_eq!(fetched.identifiers[0].value, "978-0-987654-32-1");
}

#[test]
fn test_delete_book_identifier() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib.add_book(empty_book("Test Book")).unwrap();

    lib.upsert_book_identifier(
        book.id,
        "ISBN".to_string(),
        "978-0-123456-78-9".to_string(),
        None,
    )
    .unwrap();

    let fetched = lib.get_book(book.id).unwrap();
    let identifier_id = fetched.identifiers[0].id;

    let result = lib.delete_book_identifier(book.id, identifier_id);
    assert!(result.is_ok());

    // Verify deleted
    let fetched = lib.get_book(book.id).unwrap();
    assert_eq!(fetched.identifiers.len(), 0);
}

#[test]
fn test_remove_books() {
    let (_temp, mut lib) = setup_with_library();

    let book1 = lib.add_book(empty_book("Book 1")).unwrap();
    let book2 = lib.add_book(empty_book("Book 2")).unwrap();

    assert_eq!(lib.books().unwrap().len(), 2);

    lib.remove_books(vec![book1.id, book2.id]).unwrap();

    assert_eq!(lib.books().unwrap().len(), 0);
}

#[test]
fn test_add_book_with_authors() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            title: "Multi-Author Book".to_string(),
            author_names: vec!["Author One".to_string(), "Author Two".to_string()],
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

    assert_eq!(book.authors.len(), 2);
    assert_eq!(lib.authors().unwrap().len(), 2);
}

#[test]
fn test_add_book_with_tags() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            title: "Tagged Book".to_string(),
            author_names: vec![],
            tags: Some(vec!["Fantasy".to_string(), "Epic".to_string()]),
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

    assert_eq!(book.tags, ["Epic".to_string(), "Fantasy".to_string()]);
}

#[test]
fn test_update_book_tags_replaces_existing_tags() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            title: "Tagged Book".to_string(),
            author_names: vec![],
            tags: Some(vec!["Fantasy".to_string(), "Adventure".to_string()]),
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

    let updated = lib
        .update_book(
            book.id,
            BookUpdate {
                tags: Some(vec!["Science Fiction".to_string(), "Adventure".to_string()]),
                ..empty_update()
            },
        )
        .unwrap();

    assert_eq!(
        updated.tags,
        ["Adventure".to_string(), "Science Fiction".to_string()]
    );
}

#[test]
fn test_update_book_tags_can_clear_all_tags() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            title: "Tagged Book".to_string(),
            author_names: vec![],
            tags: Some(vec!["Fantasy".to_string()]),
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

    let updated = lib
        .update_book(
            book.id,
            BookUpdate {
                tags: Some(vec![]),
                ..empty_update()
            },
        )
        .unwrap();

    assert!(updated.tags.is_empty());
}

#[test]
fn test_tag_creation_reuses_case_insensitive_matches() {
    let (temp, mut lib) = setup_with_library();

    let first = lib
        .add_book(BookAdd {
            title: "First".to_string(),
            author_names: vec![],
            tags: Some(vec!["Sci-Fi".to_string()]),
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

    let second = lib
        .add_book(BookAdd {
            title: "Second".to_string(),
            author_names: vec![],
            tags: Some(vec!["sci-fi".to_string()]),
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

    assert_eq!(first.tags, ["Sci-Fi".to_string()]);
    assert_eq!(second.tags, ["Sci-Fi".to_string()]);

    let db_path = temp.path().join("metadata.db");
    let mut conn =
        libcalibre::persistence::establish_connection(db_path.to_str().unwrap()).unwrap();
    let count = crate_tag_count(&mut conn);
    assert_eq!(count, 1);
}

fn crate_tag_count(conn: &mut diesel::SqliteConnection) -> i64 {
    #[derive(QueryableByName)]
    struct TagCount {
        #[diesel(sql_type = BigInt)]
        count: i64,
    }

    sql_query("SELECT COUNT(*) AS count FROM tags")
        .get_result::<TagCount>(conn)
        .unwrap()
        .count
}

#[test]
fn test_add_book_with_series() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            series: Some("The Saga".to_string()),
            series_index: Some(2.0),
            ..empty_book("Series Book")
        })
        .unwrap();

    assert_eq!(book.series, Some("The Saga".to_string()));
    assert_eq!(book.series_index, Some(2.0));

    let fetched = lib.get_book(book.id).unwrap();
    assert_eq!(fetched.series, Some("The Saga".to_string()));
    assert_eq!(fetched.series_index, Some(2.0));

    let all_books = lib.books().unwrap();
    let listed = all_books.iter().find(|b| b.id == book.id).unwrap();
    assert_eq!(listed.series, Some("The Saga".to_string()));
    assert_eq!(listed.series_index, Some(2.0));
}

#[test]
fn test_book_without_series_has_no_series_fields() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib.add_book(empty_book("Standalone Book")).unwrap();

    assert_eq!(book.series, None);
    assert_eq!(book.series_index, None);

    let fetched = lib.get_book(book.id).unwrap();
    assert_eq!(fetched.series, None);
    assert_eq!(fetched.series_index, None);

    let all_books = lib.books().unwrap();
    let listed = all_books.iter().find(|b| b.id == book.id).unwrap();
    assert_eq!(listed.series, None);
    assert_eq!(listed.series_index, None);
}

#[test]
fn test_update_book_can_set_series() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib.add_book(empty_book("Standalone Book")).unwrap();

    let updated = lib
        .update_book(
            book.id,
            BookUpdate {
                series: Some("The Saga".to_string()),
                series_index: Some(3.0),
                ..empty_update()
            },
        )
        .unwrap();

    assert_eq!(updated.series, Some("The Saga".to_string()));
    assert_eq!(updated.series_index, Some(3.0));
}

#[test]
fn test_update_book_can_change_series() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            series: Some("First Saga".to_string()),
            series_index: Some(1.0),
            ..empty_book("Series Book")
        })
        .unwrap();

    let updated = lib
        .update_book(
            book.id,
            BookUpdate {
                series: Some("Second Saga".to_string()),
                ..empty_update()
            },
        )
        .unwrap();

    // The book moved series and kept its index; it must not hold a second
    // link back to the old series.
    assert_eq!(updated.series, Some("Second Saga".to_string()));
    assert_eq!(updated.series_index, Some(1.0));
}

#[test]
fn test_update_book_reuses_existing_series_row() {
    let (_temp, mut lib) = setup_with_library();

    let first = lib
        .add_book(BookAdd {
            series: Some("Shared Saga".to_string()),
            series_index: Some(1.0),
            ..empty_book("Book One")
        })
        .unwrap();
    let second = lib.add_book(empty_book("Book Two")).unwrap();

    lib.update_book(
        second.id,
        BookUpdate {
            series: Some("shared saga".to_string()),
            series_index: Some(2.0),
            ..empty_update()
        },
    )
    .unwrap();

    // Case-insensitive match joins the existing series instead of creating
    // a near-duplicate row, so both books list under the same name.
    let all_books = lib.books().unwrap();
    let b1 = all_books.iter().find(|b| b.id == first.id).unwrap();
    let b2 = all_books.iter().find(|b| b.id == second.id).unwrap();
    assert_eq!(b1.series, Some("Shared Saga".to_string()));
    assert_eq!(b2.series, Some("Shared Saga".to_string()));
}

#[test]
fn test_update_book_empty_series_name_clears_series() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            series: Some("The Saga".to_string()),
            series_index: Some(2.0),
            ..empty_book("Series Book")
        })
        .unwrap();

    let updated = lib
        .update_book(
            book.id,
            BookUpdate {
                series: Some("".to_string()),
                ..empty_update()
            },
        )
        .unwrap();

    assert_eq!(updated.series, None);
    assert_eq!(updated.series_index, None);
}

#[test]
fn test_update_book_none_series_leaves_series_unchanged() {
    let (_temp, mut lib) = setup_with_library();

    let book = lib
        .add_book(BookAdd {
            series: Some("The Saga".to_string()),
            series_index: Some(2.0),
            ..empty_book("Series Book")
        })
        .unwrap();

    let updated = lib
        .update_book(
            book.id,
            BookUpdate {
                title: Some("Renamed".to_string()),
                ..empty_update()
            },
        )
        .unwrap();

    assert_eq!(updated.series, Some("The Saga".to_string()));
    assert_eq!(updated.series_index, Some(2.0));
}

#[test]
fn test_books_returns_read_state() {
    let (_temp, mut lib) = setup_with_library();

    let book1 = lib.add_book(empty_book("Book 1")).unwrap();
    let book2 = lib.add_book(empty_book("Book 2")).unwrap();

    lib.update_book(
        book1.id,
        BookUpdate {
            is_read: Some(true),
            ..empty_update()
        },
    )
    .unwrap();

    let all_books = lib.books().unwrap();
    let b1 = all_books.iter().find(|b| b.id == book1.id).unwrap();
    let b2 = all_books.iter().find(|b| b.id == book2.id).unwrap();

    assert!(b1.is_read);
    assert!(!b2.is_read);
}
