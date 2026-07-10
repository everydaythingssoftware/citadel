use std::path::Path;

use libcalibre::mime_type::MIMETYPE;
use serde::{Deserialize, Serialize};

use crate::book::{ImportableBookMetadata, LibraryAuthor};
use crate::calibre::book;
use crate::libs::cover_thumbs::{self, CoverThumbnail};
use crate::libs::file_formats;
use crate::{book::LibraryBook, state::CitadelState};

use super::custom_columns::{BookCustomValue, CustomColumnDef, CustomValueDto};
use super::onboarding::{self, DetectedLibrary, SyncStatus};
use super::ImportableFile;

#[tauri::command]
#[specta::specta]
pub fn clb_query_search_books(
    state: tauri::State<CitadelState>,
    query: String,
) -> Result<Vec<LibraryBook>, String> {
    let library_root = state
        .get_library_path()
        .ok_or("No library loaded".to_string())?;

    let books = state.with_library(|lib| book::search(library_root, lib, &query))?;
    books.map_err(|e| e.to_string())
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

#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug)]
pub enum BookSortOrder {
    TitleAsc,
    TitleDesc,
    AuthorAsc,
    AuthorDesc,
}

impl From<BookSortOrder> for libcalibre::BookSortOrder {
    fn from(sort: BookSortOrder) -> Self {
        match sort {
            BookSortOrder::TitleAsc => libcalibre::BookSortOrder::TitleAsc,
            BookSortOrder::TitleDesc => libcalibre::BookSortOrder::TitleDesc,
            BookSortOrder::AuthorAsc => libcalibre::BookSortOrder::AuthorAsc,
            BookSortOrder::AuthorDesc => libcalibre::BookSortOrder::AuthorDesc,
        }
    }
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug)]
pub struct LibraryBookQuery {
    /// Substring match across title, author names, and series names.
    /// `None` or empty text matches all books.
    pub text: Option<String>,
    pub author_id: Option<String>,
    pub series_id: Option<i32>,
    pub hide_read: bool,
    pub sort: BookSortOrder,
    /// Page size. `None` returns all matches.
    pub limit: Option<u32>,
    pub offset: u32,
}

#[derive(Serialize, Deserialize, specta::Type, Clone)]
pub struct LibraryBookPage {
    pub items: Vec<LibraryBook>,
    /// Total number of books matching the filters, ignoring limit/offset.
    pub total: u32,
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_books(
    state: tauri::State<CitadelState>,
    query: LibraryBookQuery,
) -> Result<LibraryBookPage, String> {
    let library_root = state
        .get_library_path()
        .ok_or("No library loaded".to_string())?;

    let author_id = query
        .author_id
        .as_deref()
        .map(|raw| {
            raw.parse::<libcalibre::AuthorId>()
                .map_err(|e| format!("Invalid author id '{raw}': {e}"))
        })
        .transpose()?;

    let book_query = libcalibre::BookQuery {
        text: query.text,
        author_id,
        series_id: query.series_id,
        hide_read: query.hide_read,
        sort: query.sort.into(),
        limit: query.limit.map(i64::from),
        offset: i64::from(query.offset),
    };

    let page = state.with_library(|lib| book::query_page(library_root, lib, book_query))?;
    let (items, total) = page.map_err(|e| e.to_string())?;

    Ok(LibraryBookPage {
        items,
        total: u32::try_from(total).unwrap_or(u32::MAX),
    })
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_get_book(
    state: tauri::State<CitadelState>,
    book_id: String,
) -> Result<LibraryBook, String> {
    let library_root = state
        .get_library_path()
        .ok_or("No library loaded".to_string())?;

    let book_id_int = book_id
        .parse::<i32>()
        .map_err(|e| format!("Invalid book id '{book_id}': {e}"))?;

    let book = state.with_library(|lib| {
        book::get_one(library_root, lib, libcalibre::BookId::from(book_id_int))
    })?;
    book.map_err(|e| e.to_string())
}

/// One series in the library. `id` is what [`LibraryBookQuery::series_id`]
/// filters on; the frontend otherwise only ever sees series names.
#[derive(Serialize, Deserialize, specta::Type, Clone)]
pub struct LibrarySeries {
    pub id: i32,
    pub name: String,
    pub book_count: u32,
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_list_series(
    state: tauri::State<CitadelState>,
) -> Result<Vec<LibrarySeries>, String> {
    let summaries = state
        .with_library(|lib| lib.list_series())?
        .map_err(|e| e.to_string())?;

    Ok(summaries
        .into_iter()
        .map(|series| LibrarySeries {
            id: series.id,
            name: series.name,
            book_count: u32::try_from(series.book_count).unwrap_or(u32::MAX),
        })
        .collect())
}

/// One tag in the library; `name` is what the tag autocomplete suggests.
#[derive(Serialize, Deserialize, specta::Type, Clone)]
pub struct LibraryTag {
    pub id: i32,
    pub name: String,
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_list_tags(state: tauri::State<CitadelState>) -> Result<Vec<LibraryTag>, String> {
    let tags = state
        .with_library(|lib| lib.list_tags())?
        .map_err(|e| e.to_string())?;

    Ok(tags
        .into_iter()
        .map(|tag| LibraryTag {
            id: tag.id,
            name: tag.name,
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_list_all_authors(
    state: tauri::State<CitadelState>,
) -> Result<Vec<LibraryAuthor>, String> {
    state
        .with_library(|lib| {
            let book_counts = lib.author_book_counts()?;
            lib.authors().map(|author_list| {
                author_list
                    .iter()
                    .map(|author| LibraryAuthor::from_author(author, &book_counts))
                    .collect()
            })
        })
        .and_then(|result| result.map_err(|e| format!("Failed to list authors: {}", e)))
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_is_file_importable(path_to_file: String) -> Option<ImportableFile> {
    let file_path = Path::new(&path_to_file);

    file_formats::validate_file_importable(file_path)
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_importable_file_metadata(file: ImportableFile) -> Option<ImportableBookMetadata> {
    file_formats::get_importable_file_metadata(file)
}
#[tauri::command]
#[specta::specta]
pub fn clb_query_list_all_filetypes() -> Vec<(String, String)> {
    file_formats::SupportedFormats::list_all()
        .iter()
        .filter_map(|(_, extension)| {
            MIMETYPE::from_file_extension(extension)
                .filter(|mimetype| mimetype != &MIMETYPE::UNKNOWN)
                .map(|mimetype| (mimetype.as_str().to_string(), extension.to_string()))
        })
        .collect()
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_list_custom_columns(
    state: tauri::State<CitadelState>,
) -> Result<Vec<CustomColumnDef>, String> {
    state.with_library(|lib| {
        lib.custom_columns()
            .map(|columns| columns.iter().map(CustomColumnDef::from).collect())
            .map_err(|e| e.to_string())
    })?
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_get_custom_values_for_book(
    state: tauri::State<CitadelState>,
    book_id: String,
) -> Result<Vec<BookCustomValue>, String> {
    state.with_library(|lib| {
        let book_id_int = book_id.parse::<i32>().map_err(|e| e.to_string())?;
        let values = lib
            .get_custom_values_for_book(libcalibre::BookId::from(book_id_int))
            .map_err(|e| e.to_string())?;

        // Skip values that cannot cross the Tauri boundary (e.g. an i64 out
        // of i32 range) instead of failing the whole command and hiding
        // every other column from the UI.
        let mut book_values = values
            .into_iter()
            .filter_map(|(column_id, value)| {
                CustomValueDto::try_from(value)
                    .map(|value| BookCustomValue { column_id, value })
                    .ok()
            })
            .collect::<Vec<_>>();
        book_values.sort_by_key(|book_value| book_value.column_id);
        Ok(book_values)
    })?
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

    /// The same artifact `clb_cmd_create_library` extracts, so the stats peek
    /// is tested against a real freshly-created library.
    fn extract_empty_library(target: &Path) {
        let zip_path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/empty_7_2_calibre_lib.zip");
        let file = std::fs::File::open(zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        archive.extract(target).unwrap();
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
