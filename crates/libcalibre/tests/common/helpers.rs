use libcalibre::util::get_db_path;
use libcalibre::{BookAdd, Library};
use std::collections::HashMap;
use std::path::Path;
use tempfile::TempDir;

/// The schema a Calibre 7.2 library carries, user_version 26: an older library
/// for upgrade tests, built fresh each time.
const CALIBRE_SCHEMA_26: &str = include_str!("../fixtures/calibre_schema_26.sql");

/// A fresh library at Calibre's current schema, as Citadel creates them, open
/// for writing in a temporary directory.
pub fn setup_with_library() -> (TempDir, Library) {
    let temp_dir = tempfile::tempdir().unwrap();
    let library = Library::create_library_at(temp_dir.path().to_str().unwrap())
        .expect("Failed to create Library");
    (temp_dir, library)
}

/// Writes a Calibre 7.2 library (schema 26) into `root`, journal-mode and
/// untouched by libcalibre, with a random library UUID.
pub fn write_schema_26_library(root: &Path) {
    std::fs::create_dir_all(root).unwrap();
    let conn = rusqlite::Connection::open(root.join("metadata.db")).unwrap();
    conn.execute_batch(CALIBRE_SCHEMA_26).unwrap();
    conn.execute(
        "INSERT INTO library_id (uuid) VALUES (?1)",
        [uuid::Uuid::new_v4().to_string()],
    )
    .unwrap();
}

/// A Calibre 7.2 library (schema 26) open for writing in a temporary directory.
pub fn setup_with_schema_26_library() -> (TempDir, Library) {
    let temp_dir = tempfile::tempdir().unwrap();
    write_schema_26_library(temp_dir.path());
    let valid_path =
        get_db_path(temp_dir.path().to_str().unwrap()).expect("Failed to get valid DB path");
    let library = Library::new(valid_path).expect("Failed to open Library");
    (temp_dir, library)
}

/// Standard test book used across tests
pub fn standard_test_book() -> BookAdd {
    BookAdd {
        title: "The Test Book".to_string(),
        author_names: vec!["John Doe".to_string()],
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
