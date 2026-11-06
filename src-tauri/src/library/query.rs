use std::path::Path;

use citadel_core::{
    contracts::{
        custom_columns::{BookCustomValue, CustomColumnDef},
        LibraryBookPage, LibraryBookQuery, LibraryPublisher, LibrarySeries, LibraryTag,
    },
    error::LibraryError,
    LibraryAuthor, LibraryBook,
};
use serde::{Deserialize, Serialize};

use crate::libs::cover_thumbs::{self, CoverThumbnail};
use crate::state::CitadelState;

use super::onboarding::{self, DetectedLibrary, SyncStatus};

#[tauri::command]
#[specta::specta]
pub fn clb_query_search_books(
    state: tauri::State<CitadelState>,
    query: String,
) -> Result<Vec<LibraryBook>, String> {
    state
        .with_library_service(|service| service.search_books(&query))
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_list_cover_thumbnails(
    handle: tauri::AppHandle,
    state: tauri::State<CitadelState>,
) -> Result<Vec<CoverThumbnail>, String> {
    use tauri::Manager;

    let library_root = state
        .get_library_path()
        .ok_or("No library loaded".to_string())?;
    let app_cache_dir = handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("No app cache dir: {}", e))?;

    // The returned URLs are asset-protocol; make sure the scope covers them
    // even if no ensure call has run yet this session.
    handle
        .asset_protocol_scope()
        .allow_directory(app_cache_dir.join("cover-thumbs"), true)
        .map_err(|e| format!("Failed to allow thumbnail dir: {}", e))?;

    Ok(cover_thumbs::list_thumbnails(&app_cache_dir, &library_root))
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_books(
    state: tauri::State<CitadelState>,
    query: LibraryBookQuery,
) -> Result<LibraryBookPage, LibraryError> {
    state.with_library_service(|service| service.query_books(query))
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_get_book(
    state: tauri::State<CitadelState>,
    book_id: String,
) -> Result<LibraryBook, LibraryError> {
    state.with_library_service(|service| service.get_book(&book_id))
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_list_series(
    state: tauri::State<CitadelState>,
) -> Result<Vec<LibrarySeries>, String> {
    state
        .with_library_service(|service| service.list_series())
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_list_tags(state: tauri::State<CitadelState>) -> Result<Vec<LibraryTag>, String> {
    state
        .with_library_service(|service| service.list_tags())
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_list_publishers(
    state: tauri::State<CitadelState>,
) -> Result<Vec<LibraryPublisher>, String> {
    state
        .with_library_service(|service| service.list_publishers())
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_list_all_authors(
    state: tauri::State<CitadelState>,
) -> Result<Vec<LibraryAuthor>, String> {
    state
        .with_library_service(|service| service.list_authors())
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_list_custom_columns(
    state: tauri::State<CitadelState>,
) -> Result<Vec<CustomColumnDef>, String> {
    state
        .with_library_service(|service| service.list_custom_columns())
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_get_custom_values_for_book(
    state: tauri::State<CitadelState>,
    book_id: String,
) -> Result<Vec<BookCustomValue>, String> {
    state
        .with_library_service(|service| service.get_custom_values(&book_id))
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_is_path_valid_library(library_root: String) -> bool {
    let db_path = libcalibre::util::get_db_path(&library_root);
    db_path.is_some()
}

/// Find an existing Calibre library for first-run onboarding: Calibre's own
/// config (`global.py.json`) first, then the default `~/Calibre Library`
/// folder. `None` means nothing detected — never an error.
#[tauri::command]
#[specta::specta]
pub fn clb_query_detect_calibre_library(handle: tauri::AppHandle) -> Option<DetectedLibrary> {
    use tauri::Manager;

    let home = handle.path().home_dir().ok()?;
    onboarding::detect_calibre_library(&home)
}

/// Headline counts for the post-open reveal. i64 mirrors SQLite's COUNT;
/// exported to TS as `number` (see the bigint exporter setting in main.rs).
#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug)]
pub struct LibraryStats {
    pub book_count: i64,
    pub author_count: i64,
}

/// Read-only peek at the library under `library_root`, without touching the
/// app's active library state — safe to call on a path the user has merely
/// pointed at.
#[tauri::command]
#[specta::specta]
pub fn clb_query_library_stats(library_root: String) -> Result<LibraryStats, String> {
    let db_path = libcalibre::util::get_db_path(&library_root)
        .ok_or_else(|| format!("No Calibre library at '{library_root}'"))?;
    let stats = libcalibre::library_stats(&db_path).map_err(|e| e.to_string())?;
    Ok(LibraryStats {
        book_count: stats.book_count,
        author_count: stats.author_count,
    })
}

/// Best-effort cloud-sync detection for a candidate library path, backing the
/// warn-don't-block onboarding UX. Unknown providers report unsynced.
#[tauri::command]
#[specta::specta]
pub fn clb_query_path_sync_status(path: String) -> SyncStatus {
    onboarding::path_sync_status(Path::new(&path))
}

/// Suggested folder for a brand-new library (`~/Citadel`). Resolved only —
/// nothing is created until `clb_cmd_create_library`.
#[tauri::command]
#[specta::specta]
pub fn clb_query_default_new_library_path(handle: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;

    let home = handle
        .path()
        .home_dir()
        .map_err(|e| format!("Cannot resolve home directory: {e}"))?;
    Ok(onboarding::default_new_library_path(&home))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same creation `clb_cmd_create_library` runs, so the stats peek is
    /// tested against a real freshly-created library.
    fn extract_empty_library(target: &Path) {
        libcalibre::Library::create_library_at(target.to_str().unwrap()).unwrap();
    }

    #[test]
    fn library_stats_on_fresh_library_are_zero() {
        let tmp = tempfile::tempdir().unwrap();
        extract_empty_library(tmp.path());

        let stats = clb_query_library_stats(tmp.path().to_string_lossy().into_owned()).unwrap();
        assert_eq!(stats.book_count, 0);
        assert_eq!(stats.author_count, 0);
    }

    #[test]
    fn library_stats_count_books_and_distinct_authors() {
        let tmp = tempfile::tempdir().unwrap();
        extract_empty_library(tmp.path());

        let library_root = tmp.path().to_string_lossy().into_owned();
        let db_path = libcalibre::util::get_db_path(&library_root).unwrap();
        let mut lib = libcalibre::Library::new(db_path).unwrap();
        lib.add_book(test_book("Book One", vec!["Ann Author"]))
            .unwrap();
        lib.add_book(test_book("Book Two", vec!["Ann Author", "Bob Writer"]))
            .unwrap();

        let stats = clb_query_library_stats(library_root).unwrap();
        assert_eq!(stats.book_count, 2);
        assert_eq!(stats.author_count, 2);
    }

    #[test]
    fn library_stats_error_on_non_library_path() {
        let tmp = tempfile::tempdir().unwrap();
        let result = clb_query_library_stats(tmp.path().to_string_lossy().into_owned());
        assert!(result.is_err());
    }

    fn dir_listing(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn library_stats_leave_journal_mode_library_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        extract_empty_library(tmp.path());

        let before = dir_listing(tmp.path());
        let stats = clb_query_library_stats(tmp.path().to_string_lossy().into_owned()).unwrap();
        assert_eq!(stats.book_count, 0);
        assert_eq!(dir_listing(tmp.path()), before);
    }

    /// A WAL-mode library (Citadel itself opened it before) can't stay
    /// byte-identical on disk: reading WAL requires `-wal`/`-shm` sidecars,
    /// which macOS persists past close for every connection (see
    /// `library_stats`). Honest contract: the database file's bytes never
    /// change, and nothing beyond those two sidecars appears.
    #[test]
    fn library_stats_on_wal_mode_library_add_at_most_wal_sidecars() {
        use diesel::connection::SimpleConnection;
        use diesel::prelude::*;

        let tmp = tempfile::tempdir().unwrap();
        extract_empty_library(tmp.path());

        let db_file = tmp.path().join("metadata.db");
        diesel::SqliteConnection::establish(db_file.to_str().unwrap())
            .unwrap()
            .batch_execute("PRAGMA journal_mode = WAL;")
            .unwrap();
        let db_bytes = std::fs::read(&db_file).unwrap();
        assert_eq!(
            &db_bytes[18..20],
            &[2, 2],
            "fixture did not persist WAL mode"
        );
        let before = dir_listing(tmp.path());

        let stats = clb_query_library_stats(tmp.path().to_string_lossy().into_owned()).unwrap();
        assert_eq!(stats.book_count, 0);
        assert_eq!(stats.author_count, 0);

        assert_eq!(std::fs::read(&db_file).unwrap(), db_bytes);
        let new_files: Vec<String> = dir_listing(tmp.path())
            .into_iter()
            .filter(|name| !before.contains(name))
            .collect();
        assert!(
            new_files
                .iter()
                .all(|name| name == "metadata.db-wal" || name == "metadata.db-shm"),
            "unexpected new files: {new_files:?}"
        );
    }

    fn test_book(title: &str, authors: Vec<&str>) -> libcalibre::BookAdd {
        libcalibre::BookAdd {
            title: title.to_string(),
            author_names: authors.into_iter().map(String::from).collect(),
            tags: None,
            series: None,
            series_index: None,
            publisher: None,
            publication_date: None,
            rating: None,
            comments: None,
            identifiers: std::collections::HashMap::new(),
            language: None,
            file_paths: Vec::new(),
        }
    }
}
