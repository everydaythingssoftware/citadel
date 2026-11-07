mod common;

use std::path::{Path, PathBuf};

use common::{
    setup_with_library, setup_with_schema_26_library, standard_test_book, write_schema_26_library,
};
use libcalibre::{upgrade_backups, CalibreError, Library, MINIMUM_SCHEMA_VERSION, SCHEMA_VERSION};
use rusqlite::Connection;

fn fixture_copy() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    write_schema_26_library(temp.path());
    let database = temp.path().join("metadata.db");
    (temp, database)
}

fn user_version(database: &Path) -> i32 {
    Connection::open(database)
        .unwrap()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap()
}

fn set_user_version(database: &Path, version: i32) {
    Connection::open(database)
        .unwrap()
        .execute_batch(&format!("PRAGMA user_version = {version}"))
        .unwrap();
}

fn columns(database: &Path, table: &str) -> Vec<String> {
    let conn = Connection::open(database).unwrap();
    let mut statement = conn
        .prepare("SELECT name FROM pragma_table_info(?)")
        .unwrap();
    statement
        .query_map([table], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn open(root: &Path) -> Library {
    Library::open(root).unwrap()
}

#[test]
fn create_library_at_makes_a_current_library_with_its_own_uuid() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("nested").join("Books");
    let mut library = Library::create_library_at(root.to_str().unwrap()).unwrap();
    assert_eq!(library.schema_version().unwrap(), SCHEMA_VERSION);
    assert!(!library.upgrade_available().unwrap());
    let uuid = library.library_uuid().unwrap();
    assert_eq!(uuid.len(), 36, "{uuid}");

    let book = library.add_book(standard_test_book()).unwrap();
    let pages: i64 = Connection::open(root.join("metadata.db"))
        .unwrap()
        .query_row(
            "SELECT count(*) FROM books_pages_link WHERE book = ?",
            [book.id.0],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pages, 1, "Calibre's insert trigger fills books_pages_link");

    let other = temp.path().join("Other");
    let mut other_library = Library::create_library_at(other.to_str().unwrap()).unwrap();
    assert_ne!(other_library.library_uuid().unwrap(), uuid);

    assert!(matches!(
        Library::create_library_at(root.to_str().unwrap()),
        Err(CalibreError::LibraryAlreadyExists(path)) if path == root
    ));
}

#[test]
fn a_calibre_7_2_library_upgrades_from_26_to_28_with_a_backup_beside_it() {
    let (temp, mut library) = setup_with_schema_26_library();
    let database = temp.path().join("metadata.db");
    let book = library.add_book(standard_test_book()).unwrap();
    assert_eq!(library.schema_version().unwrap(), 26);
    assert!(library.upgrade_available().unwrap());

    let upgrade = library.upgrade().unwrap().unwrap();
    assert_eq!((upgrade.from, upgrade.to), (26, SCHEMA_VERSION));
    let backup_name = upgrade.backup.file_name().unwrap().to_string_lossy();
    assert!(
        backup_name.starts_with("metadata.db.backup-26-"),
        "{backup_name}"
    );
    assert_eq!(upgrade.backup.parent().unwrap(), temp.path());
    assert_eq!(user_version(&upgrade.backup), 26);
    let backed_up_books: i64 = Connection::open(&upgrade.backup)
        .unwrap()
        .query_row("SELECT count(*) FROM books", [], |row| row.get(0))
        .unwrap();
    assert_eq!(backed_up_books, 1);

    assert_eq!(library.schema_version().unwrap(), SCHEMA_VERSION);
    assert!(!library.upgrade_available().unwrap());
    let needs_scan: i64 = Connection::open(&database)
        .unwrap()
        .query_row(
            "SELECT needs_scan FROM books_pages_link WHERE book = ?",
            [book.id.0],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(needs_scan, 1, "existing books are queued for a page count");
    assert!(columns(&database, "book_storage").contains(&"user_type".to_string()));
    for dropped in ["flags", "isbn", "lccn"] {
        assert!(columns(&upgrade.backup, "books").contains(&dropped.to_string()));
        assert!(!columns(&database, "books").contains(&dropped.to_string()));
    }

    library.add_book(standard_test_book()).unwrap();
    assert_eq!(library.upgrade().unwrap(), None);
    assert_eq!(upgrade_backups(&database).unwrap().len(), 1);

    drop(library);
    let mut reopened = open(temp.path());
    assert_eq!(reopened.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(reopened.library_uuid().unwrap().len(), 36);
}

#[test]
fn a_version_25_library_gains_link_columns() {
    let (temp, database) = fixture_copy();
    {
        let conn = Connection::open(&database).unwrap();
        conn.execute_batch(
            "ALTER TABLE tags DROP COLUMN link;
             ALTER TABLE series DROP COLUMN link;
             ALTER TABLE publishers DROP COLUMN link;
             ALTER TABLE languages DROP COLUMN link;
             ALTER TABLE ratings DROP COLUMN link;
             INSERT INTO custom_columns (id, label, name, datatype, normalized)
                 VALUES (7, 'shelf', 'Shelf', 'text', 1);
             CREATE TABLE custom_column_7 (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
             PRAGMA user_version = 25;",
        )
        .unwrap();
    }
    let mut library = open(temp.path());
    assert_eq!(library.schema_version().unwrap(), 25);
    let upgrade = library.upgrade().unwrap().unwrap();
    assert_eq!(upgrade.from, 25);
    for table in [
        "tags",
        "series",
        "publishers",
        "languages",
        "ratings",
        "custom_column_7",
    ] {
        assert!(
            columns(&database, table).contains(&"link".to_string()),
            "{table} has no link column"
        );
    }
    assert_eq!(user_version(&database), SCHEMA_VERSION);
}

#[test]
fn libraries_older_than_the_minimum_are_refused_with_calibre_advice() {
    let (temp, database) = fixture_copy();
    set_user_version(&database, MINIMUM_SCHEMA_VERSION - 1);
    for result in [
        Library::open(temp.path()),
        Library::open_read_only(temp.path()),
    ] {
        let error = result.err().expect("an old schema is refused");
        assert!(
            matches!(
                error,
                CalibreError::UnsupportedSchema {
                    version: 24,
                    minimum: 25
                }
            ),
            "{error}"
        );
        assert!(error.to_string().contains("open it in Calibre"), "{error}");
    }
    std::fs::write(temp.path().join("metadata.db"), b"").unwrap();
    assert!(matches!(
        Library::open(temp.path()),
        Err(CalibreError::DatabaseIntegrity(_))
    ));
}

#[test]
fn only_the_newest_three_backups_are_kept() {
    let (temp, mut library) = setup_with_schema_26_library();
    let database = temp.path().join("metadata.db");
    let mut taken = Vec::new();
    for _ in 0..4 {
        Connection::open(&database)
            .unwrap()
            .execute_batch("DROP TABLE IF EXISTS book_storage; PRAGMA user_version = 27")
            .unwrap();
        taken.push(library.upgrade().unwrap().unwrap().backup);
    }
    let kept = upgrade_backups(&database).unwrap();
    assert_eq!(kept.len(), 3);
    assert_eq!(kept[0], taken[3], "newest first");
    assert!(!taken[0].exists(), "the oldest copy was pruned");
    assert!(taken[1..].iter().all(|path| path.exists()));
}

#[test]
fn read_only_handles_refuse_to_upgrade_without_touching_the_file() {
    let (temp, database) = fixture_copy();
    let before = std::fs::read(&database).unwrap();
    let mut library = Library::open_read_only(temp.path()).unwrap();
    assert!(library.upgrade_available().unwrap());
    assert!(matches!(
        library.upgrade(),
        Err(CalibreError::ReadOnlyLibrary)
    ));
    assert_eq!(std::fs::read(&database).unwrap(), before);
    assert!(upgrade_backups(&database).unwrap().is_empty());
}

/// Every table's columns, index's columns, trigger's table and view's columns,
/// as SQLite reports them: a schema's shape, whatever its SQL text.
fn catalogue(database: &Path) -> Vec<String> {
    use rusqlite::functions::FunctionFlags;
    let conn = Connection::open(database).unwrap();
    // Views call these; the host registers them on each connection.
    for function in ["books_list_filter", "title_sort"] {
        conn.create_scalar_function(function, 1, FunctionFlags::SQLITE_DETERMINISTIC, |_| Ok(1))
            .unwrap();
    }
    let objects: Vec<(String, String, String)> = conn
        .prepare(
            "SELECT type, name, tbl_name FROM sqlite_master \
             WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let mut entries = Vec::new();
    for (kind, name, table) in objects {
        let detail: Vec<String> = match kind.as_str() {
            "table" | "view" => conn
                .prepare(&format!("PRAGMA table_xinfo('{name}')"))
                .unwrap()
                .query_map([], |row| {
                    Ok(format!(
                        "{} {} notnull={} default={:?} pk={}",
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?
                    ))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect(),
            "index" => conn
                .prepare(&format!("PRAGMA index_xinfo('{name}')"))
                .unwrap()
                .query_map([], |row| {
                    Ok(format!(
                        "{:?} {:?}",
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(4)?
                    ))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect(),
            _ => Vec::new(),
        };
        entries.push(format!("{kind} {name} on {table}: {}", detail.join(", ")));
    }
    entries
}

#[test]
fn a_new_library_and_an_upgraded_calibre_library_have_the_same_schema() {
    let (_created_dir, created) = setup_with_library();
    let (_upgraded_dir, mut upgraded) = setup_with_schema_26_library();
    upgraded.upgrade().unwrap().unwrap();

    let created = catalogue(created.database_path());
    let upgraded = catalogue(upgraded.database_path());
    let differences: Vec<_> = created
        .iter()
        .filter(|entry| !upgraded.contains(entry))
        .map(|entry| format!("only in new: {entry}"))
        .chain(
            upgraded
                .iter()
                .filter(|entry| !created.contains(entry))
                .map(|entry| format!("only in upgraded: {entry}")),
        )
        .collect();
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}

#[test]
fn a_migration_that_meets_an_unexpected_schema_fails_and_changes_nothing() {
    let (temp, database) = fixture_copy();
    // A version-26 library already holding what migration 26 -> 27 creates.
    Connection::open(&database)
        .unwrap()
        .execute_batch("CREATE TABLE books_pages_link (book INTEGER PRIMARY KEY)")
        .unwrap();

    let error = open(temp.path()).upgrade().unwrap_err();
    assert!(error.to_string().contains("books_pages_link"), "{error}");
    assert_eq!(user_version(&database), 26);
    assert!(!columns(&database, "books").is_empty());
    assert!(columns(&database, "books").contains(&"isbn".to_string()));
}
