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
        description: None,
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
fn test_add_book_saves_publisher_comments_and_identifiers() {
    let (_temp, mut lib) = setup_with_library();
    let mut first = empty_book("First");
    first.publisher = Some("  Small Press ".into());
    first.description = Some("<p>A description.</p>".into());
    first.identifiers = HashMap::from([
        ("isbn".to_string(), "9780000000002".to_string()),
        ("goodreads".to_string(), "42".to_string()),
    ]);
    let first = lib.add_book(first).unwrap();
    let mut identifiers: Vec<_> = first
        .identifiers
        .iter()
        .map(|identifier| (identifier.label.as_str(), identifier.value.as_str()))
        .collect();
    identifiers.sort();
    assert_eq!(
        identifiers,
        [("goodreads", "42"), ("isbn", "9780000000002")]
    );
    assert_eq!(first.description.as_deref(), Some("<p>A description.</p>"));

    // Publishers match case-insensitively, as in Calibre.
    let mut second = empty_book("Second");
    second.publisher = Some("small press".into());
    lib.add_book(second).unwrap();
    let mut blank = empty_book("Blank");
    blank.publisher = Some(" ".into());
    blank.description = Some(" ".into());
    let blank = lib.add_book(blank).unwrap();
    assert_eq!(blank.description, None);

    let publishers = lib.list_publishers().unwrap();
    assert_eq!(publishers.len(), 1);
    assert_eq!(publishers[0].name, "Small Press");
    assert_eq!(publishers[0].book_count, 2);
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

fn dirtied(lib: &libcalibre::Library) -> Vec<i32> {
    let conn = rusqlite::Connection::open(lib.database_path()).unwrap();
    let mut statement = conn
        .prepare("SELECT book FROM metadata_dirtied ORDER BY book")
        .unwrap();
    statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// What Calibre's backup writer does once it has written a book's OPF.
fn clear_dirtied(lib: &libcalibre::Library) {
    rusqlite::Connection::open(lib.database_path())
        .unwrap()
        .execute("DELETE FROM metadata_dirtied", [])
        .unwrap();
}

#[test]
fn test_changed_books_are_queued_for_calibres_opf_backup() {
    let (_temp, mut lib) = setup_with_library();
    let book = lib.add_book(empty_book("Book")).unwrap();
    let other = lib.add_book(empty_book("Other")).unwrap();
    assert_eq!(dirtied(&lib), [book.id.as_i32(), other.id.as_i32()]);

    let opf = std::path::Path::new(lib.library_path())
        .join(&book.book_dir_path)
        .join("metadata.opf");
    assert!(!opf.exists(), "libcalibre leaves metadata.opf to Calibre");
    std::fs::write(&opf, "written by Calibre").unwrap();

    clear_dirtied(&lib);
    lib.update_book(
        book.id,
        BookUpdate {
            title: Some("Renamed".to_string()),
            ..empty_update()
        },
    )
    .unwrap();
    assert_eq!(dirtied(&lib), [book.id.as_i32()]);
    assert_eq!(std::fs::read_to_string(&opf).unwrap(), "written by Calibre");

    clear_dirtied(&lib);
    lib.set_book_read_state(other.id, true).unwrap();
    assert_eq!(dirtied(&lib), [other.id.as_i32()]);

    clear_dirtied(&lib);
    lib.set_book_cover(book.id, vec![0xFF, 0xD8, 0xFF]).unwrap();
    assert_eq!(dirtied(&lib), [book.id.as_i32()]);
}

#[test]
fn test_catalogue_wide_changes_queue_no_book() {
    let (_temp, mut lib) = setup_with_library();
    lib.add_book(empty_book("Book")).unwrap();
    clear_dirtied(&lib);

    lib.randomize_library_uuid().unwrap();
    assert!(dirtied(&lib).is_empty());
}

#[test]
fn test_deleting_a_book_drops_it_from_the_backup_queue() {
    let (_temp, mut lib) = setup_with_library();
    let doomed = lib.add_book(empty_book("Doomed")).unwrap();
    let kept = lib.add_book(empty_book("Kept")).unwrap();

    lib.delete_books(&[doomed.id]).unwrap();
    assert_eq!(dirtied(&lib), [kept.id.as_i32()]);
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
            description: None,
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
            description: None,
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
            description: None,
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
            description: None,
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
            description: None,
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
            description: None,
            identifiers: HashMap::new(),
            language: None,
            file_paths: vec![],
        })
        .unwrap();

    assert_eq!(first.tags, ["Sci-Fi".to_string()]);
    assert_eq!(second.tags, ["Sci-Fi".to_string()]);

    let db_path = temp.path().join("metadata.db");
    let mut conn =
        libcalibre::__internals::establish_connection(db_path.to_str().unwrap()).unwrap();
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

#[test]
fn book_without_an_author_is_filed_under_unknown() {
    let (temp, mut lib) = setup_with_library();
    let mut book = empty_book("Repair manual");
    book.author_names = vec!["  ".to_string()];
    let book = lib.add_book(book).unwrap();

    let names: Vec<_> = book
        .authors
        .iter()
        .map(|author| author.name.as_str())
        .collect();
    assert_eq!(names, ["Unknown"]);
    let folder =
        std::path::Path::new("Unknown").join(format!("Repair manual ({})", book.id.as_i32()));
    assert_eq!(std::path::Path::new(&book.book_dir_path), folder);
    assert!(temp.path().join(&folder).is_dir());

    let folders = lib.delete_books(&[book.id]).unwrap();
    assert_eq!(folders, [temp.path().canonicalize().unwrap().join(folder)]);
}

#[test]
fn author_folder_name_is_sanitised() {
    let (temp, mut lib) = setup_with_library();
    let mut book = empty_book("Live");
    book.author_names = vec!["AC/DC".to_string()];
    let book = lib.add_book(book).unwrap();
    let components: Vec<_> = std::path::Path::new(&book.book_dir_path)
        .components()
        .collect();
    assert_eq!(components.len(), 2, "{}", book.book_dir_path);
    assert!(temp.path().join(&book.book_dir_path).is_dir());
}

fn stored_pubdate(lib: &libcalibre::Library, id: BookId) -> String {
    let conn = rusqlite::Connection::open(lib.database_path()).unwrap();
    conn.query_row(
        "SELECT pubdate FROM books WHERE id = ?1",
        [id.as_i32()],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn test_book_reads_back_publisher_rating_and_publication_date() {
    let (_temp, mut lib) = setup_with_library();
    let added = lib
        .add_book(BookAdd {
            publisher: Some("Tor".to_string()),
            rating: Some(8),
            publication_date: chrono::NaiveDate::from_ymd_opt(1993, 6, 1),
            description: Some("<p>A thief.</p>".to_string()),
            ..empty_book("Book")
        })
        .unwrap();

    for book in [
        lib.get_book(added.id).unwrap(),
        lib.books().unwrap().remove(0),
    ] {
        assert_eq!(book.publisher.as_deref(), Some("Tor"));
        assert_eq!(book.rating, Some(8));
        assert_eq!(
            book.publication_date,
            chrono::NaiveDate::from_ymd_opt(1993, 6, 1)
        );
        assert_eq!(book.description.as_deref(), Some("<p>A thief.</p>"));
    }
}

#[test]
fn test_book_without_a_publication_date_stores_calibres_undefined_date() {
    let (_temp, mut lib) = setup_with_library();
    let book = lib.add_book(empty_book("Undated")).unwrap();

    assert_eq!(book.publication_date, None);
    assert_eq!(book.rating, None);
    assert_eq!(book.publisher, None);
    assert!(stored_pubdate(&lib, book.id).starts_with("0101-01-01"));
}

#[test]
fn test_update_book_sets_and_clears_publisher_and_rating() {
    let (_temp, mut lib) = setup_with_library();
    let id = lib.add_book(empty_book("Book")).unwrap().id;

    let book = lib
        .update_book(
            id,
            BookUpdate {
                publisher: Some("Orbit".to_string()),
                rating: Some(10),
                ..BookUpdate::default()
            },
        )
        .unwrap();
    assert_eq!(book.publisher.as_deref(), Some("Orbit"));
    assert_eq!(book.rating, Some(10));

    let book = lib
        .update_book(
            id,
            BookUpdate {
                publisher: Some("Tor".to_string()),
                rating: Some(4),
                ..BookUpdate::default()
            },
        )
        .unwrap();
    assert_eq!(book.publisher.as_deref(), Some("Tor"));
    assert_eq!(book.rating, Some(4));

    let book = lib
        .update_book(
            id,
            BookUpdate {
                publisher: Some("  ".to_string()),
                rating: Some(0),
                ..BookUpdate::default()
            },
        )
        .unwrap();
    assert_eq!(book.publisher, None);
    assert_eq!(book.rating, None);
    let publishers = lib.list_publishers().unwrap();
    assert!(publishers
        .iter()
        .any(|p| p.name == "Tor" && p.book_count == 0));
}

#[test]
fn test_update_book_refuses_a_rating_out_of_range() {
    let (_temp, mut lib) = setup_with_library();
    let id = lib.add_book(empty_book("Book")).unwrap().id;

    let error = lib
        .update_book(
            id,
            BookUpdate {
                rating: Some(11),
                title: Some("Renamed".to_string()),
                ..BookUpdate::default()
            },
        )
        .unwrap_err();
    assert!(matches!(error, libcalibre::CalibreError::InvalidRating(11)));
    assert_eq!(
        lib.get_book(id).unwrap().title,
        "Book",
        "nothing else changed"
    );
}

#[test]
fn test_update_book_replaces_identifiers() {
    let (_temp, mut lib) = setup_with_library();
    let id = lib
        .add_book(BookAdd {
            identifiers: HashMap::from([
                ("isbn".to_string(), "9780765326355".to_string()),
                ("goodreads".to_string(), "7235533".to_string()),
            ]),
            ..empty_book("Book")
        })
        .unwrap()
        .id;

    let book = lib
        .update_book(
            id,
            BookUpdate {
                identifiers: Some(HashMap::from([
                    ("ISBN".to_string(), "9780765365279".to_string()),
                    ("amazon".to_string(), " ".to_string()),
                ])),
                ..BookUpdate::default()
            },
        )
        .unwrap();
    let identifiers: Vec<_> = book
        .identifiers
        .iter()
        .map(|i| (i.label.as_str(), i.value.as_str()))
        .collect();
    assert_eq!(identifiers, [("isbn", "9780765365279")]);

    let book = lib
        .update_book(
            id,
            BookUpdate {
                identifiers: Some(HashMap::new()),
                ..BookUpdate::default()
            },
        )
        .unwrap();
    assert!(book.identifiers.is_empty());
}

#[test]
fn test_add_book_refuses_a_rating_out_of_range_before_writing() {
    let (_temp, mut lib) = setup_with_library();

    let error = lib
        .add_book(BookAdd {
            rating: Some(11),
            ..empty_book("Book")
        })
        .unwrap_err();
    assert!(matches!(error, libcalibre::CalibreError::InvalidRating(11)));
    assert!(lib.books().unwrap().is_empty());
}
