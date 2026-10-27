use tauri::Manager;

use crate::account::LocalAccount;
use crate::imports::ImportableBookMetadata;
use crate::libs::cover_thumbs::{self, CoverThumbnail};
use crate::state::CitadelState;
use citadel_core::{
    contracts::{custom_columns::CustomValueDto, AuthorUpdate, BookUpdate, NewAuthor},
    Actor, LibraryAuthor,
};

use super::onboarding::{self, CreateTargetBlocker};

/// Exact error strings `clb_cmd_create_library` returns when it refuses the
/// target folder. The frontend matches on them to offer alternatives: "open
/// it instead" for an existing library, "pick another folder" for content.
pub const ERR_CREATE_LIBRARY_TARGET_IS_LIBRARY: &str = "create-library/already-a-library";
pub const ERR_CREATE_LIBRARY_TARGET_NOT_EMPTY: &str = "create-library/folder-not-empty";

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_update_book(
    state: tauri::State<CitadelState>,
    account: tauri::State<LocalAccount>,
    book_id: String,
    updates: BookUpdate,
) -> Result<i32, String> {
    state
        .with_library_service(|service| service.update_book(&account.actor(), &book_id, updates))
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_set_custom_value(
    state: tauri::State<CitadelState>,
    account: tauri::State<LocalAccount>,
    book_id: String,
    column_id: i32,
    value: Option<CustomValueDto>,
) -> Result<(), String> {
    state
        .with_library_service(|service| {
            service.set_custom_value(&account.actor(), &book_id, column_id, value)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_add_book_genres(
    state: tauri::State<CitadelState>,
    account: tauri::State<LocalAccount>,
    book_id: String,
    genres: Vec<String>,
) -> Result<(), String> {
    state
        .with_library_service(|service| service.add_genres(&account.actor(), &book_id, genres))
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_create_library(
    handle: tauri::AppHandle,
    library_root: String,
) -> Result<(), String> {
    // Never unpack into a folder that already holds anything real: extraction
    // into a populated folder silently interleaves library files with the
    // user's data. A missing folder is fine — extract() creates it.
    match onboarding::create_target_blocker(std::path::Path::new(&library_root)) {
        Ok(None) => {}
        Ok(Some(CreateTargetBlocker::AlreadyALibrary)) => {
            return Err(ERR_CREATE_LIBRARY_TARGET_IS_LIBRARY.to_string())
        }
        Ok(Some(CreateTargetBlocker::NotEmpty)) => {
            return Err(ERR_CREATE_LIBRARY_TARGET_NOT_EMPTY.to_string())
        }
        Err(e) => return Err(format!("Failed to inspect '{library_root}': {e}")),
    }

    let resource_path = handle
        .path()
        .resolve(
            "resources/empty_7_2_calibre_lib.zip",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Failed to find default empty library: {}", e))?;

    let file = std::fs::File::open(resource_path)
        .map_err(|e| format!("Failed to open default empty library: {}", e))?;

    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip archive: {}", e))?;
    let result = archive.extract(&library_root).map_err(|e| e.to_string());

    // Set a new UUID for the library
    if let Some(db_path) = libcalibre::util::get_db_path(&library_root) {
        if let Ok(mut lib) = libcalibre::Library::new(db_path) {
            let _ = lib.randomize_library_uuid();
        }
    }

    result
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_create_book(
    state: tauri::State<CitadelState>,
    account: tauri::State<LocalAccount>,
    md: ImportableBookMetadata,
) -> Result<String, String> {
    state
        .with_library_service(|service| service.create_book(&account.actor(), md.to_book_add()))
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_upsert_book_identifier(
    state: tauri::State<CitadelState>,
    account: tauri::State<LocalAccount>,
    book_id: String,
    label: String,
    value: String,
    existing_id: Option<i32>,
) -> Result<(), String> {
    state
        .with_library_service(|service| {
            service.upsert_identifier(&account.actor(), &book_id, label, value, existing_id)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_delete_book_identifier(
    state: tauri::State<CitadelState>,
    account: tauri::State<LocalAccount>,
    book_id: String,
    identifier_id: i32,
) -> Result<(), String> {
    state
        .with_library_service(|service| {
            service.delete_identifier(&account.actor(), &book_id, identifier_id)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_set_book_cover_from_url(
    state: tauri::State<'_, CitadelState>,
    account: tauri::State<'_, LocalAccount>,
    book_id: String,
    image_url: String,
) -> Result<(), String> {
    download_book_cover(
        state.inner(),
        &account.actor(),
        book_id,
        image_url,
        &reqwest::Client::new(),
    )
    .await
}

async fn download_book_cover(
    state: &CitadelState,
    actor: &Actor,
    book_id: String,
    image_url: String,
    client: &reqwest::Client,
) -> Result<(), String> {
    let library_root = state.with_library(|library| library.library_path().to_owned())?;
    let image_url = image_url.trim();
    if image_url.is_empty() {
        return Err("Image URL is empty".to_string());
    }

    let response = client
        .get(image_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download cover image: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Cover image request returned status {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read cover image bytes: {}", e))?;

    state.with_library(|library| {
        if library.library_path() != library_root {
            return Err("Library changed while downloading the cover".to_string());
        }
        citadel_core::library::LibraryService::new(library, &citadel_core::AssetUrlBuilder)
            .set_cover(actor, &book_id, bytes.to_vec())
            .map_err(|error| error.to_string())
    })?
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_ensure_cover_thumbnails(
    handle: tauri::AppHandle,
    state: tauri::State<'_, CitadelState>,
    book_ids: Vec<String>,
) -> Result<Vec<CoverThumbnail>, String> {
    let library_root = state
        .get_library_path()
        .ok_or("No library initialized. Please load a library first.")?;

    // Cheap DB lookups stay on this thread; only the decode/resize work
    // moves to the blocking pool.
    // Parse the requested ids, then read just (id, folder) for the ones that
    // exist and have a cover — no per-book hydration. cover_sources_for already
    // applies the has_cover filter, so unparseable/missing/coverless ids drop
    // out exactly as the old per-id path did.
    let ids: Vec<libcalibre::BookId> = book_ids
        .iter()
        .filter_map(|id| id.parse::<i32>().ok())
        .map(libcalibre::BookId::from)
        .collect();

    let sources = state.with_library(|lib| {
        lib.cover_sources_for(&ids)
            .map(|rows| {
                rows.into_iter()
                    .map(|(id, book_dir_path)| cover_thumbs::CoverSource {
                        book_id: id.as_i32().to_string(),
                        cover_path: std::path::PathBuf::from(&library_root)
                            .join(&book_dir_path)
                            .join("cover.jpg"),
                    })
                    .collect::<Vec<_>>()
            })
            .map_err(|e| e.to_string())
    })??;

    let app_cache_dir = handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("No app cache dir: {}", e))?;

    // Thumbnails are served over the asset protocol like full covers; the
    // cache dir is app-owned, so granting it once per call is safe and
    // idempotent.
    handle
        .asset_protocol_scope()
        .allow_directory(app_cache_dir.join("cover-thumbs"), true)
        .map_err(|e| format!("Failed to allow thumbnail dir: {}", e))?;

    tauri::async_runtime::spawn_blocking(move || {
        cover_thumbs::ensure_thumbnails(&app_cache_dir, &library_root, &sources)
    })
    .await
    .map_err(|e| format!("Thumbnail generation failed: {}", e))
}

/// Generate thumbnails for the ENTIRE library in the background, so the grid
/// can paint instantly at any scroll offset — not just visited pages. First
/// run on a big library takes a while (decode every cover once); later runs
/// are an mtime sweep. Returns the full thumbnail set when done; the caller
/// merges it whenever it lands.
#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_warm_cover_thumbnails(
    handle: tauri::AppHandle,
    state: tauri::State<'_, CitadelState>,
) -> Result<Vec<CoverThumbnail>, String> {
    let library_root = state
        .get_library_path()
        .ok_or("No library initialized. Please load a library first.")?;

    // Only (id, folder) per covered book — no author/tag/series/file/read-state
    // hydration, which the freshness sweep never reads.
    let sources = state.with_library(|lib| {
        lib.cover_sources()
            .map(|rows| {
                rows.into_iter()
                    .map(|(id, book_dir_path)| cover_thumbs::CoverSource {
                        book_id: id.as_i32().to_string(),
                        cover_path: std::path::PathBuf::from(&library_root)
                            .join(&book_dir_path)
                            .join("cover.jpg"),
                    })
                    .collect::<Vec<_>>()
            })
            .map_err(|e| e.to_string())
    })??;

    let app_cache_dir = handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("No app cache dir: {}", e))?;
    handle
        .asset_protocol_scope()
        .allow_directory(app_cache_dir.join("cover-thumbs"), true)
        .map_err(|e| format!("Failed to allow thumbnail dir: {}", e))?;

    tauri::async_runtime::spawn_blocking(move || {
        // Batched so visible-page ensure calls interleave at index-merge
        // points instead of waiting behind the whole library.
        sources
            .chunks(64)
            .flat_map(|chunk| cover_thumbs::ensure_thumbnails(&app_cache_dir, &library_root, chunk))
            .collect()
    })
    .await
    .map_err(|e| format!("Thumbnail warm failed: {}", e))
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_update_author(
    state: tauri::State<CitadelState>,
    account: tauri::State<LocalAccount>,
    author_id: String,
    updates: AuthorUpdate,
) -> Result<i32, String> {
    state
        .with_library_service(|service| {
            service.update_author(&account.actor(), &author_id, updates)
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_delete_author(
    state: tauri::State<CitadelState>,
    account: tauri::State<LocalAccount>,
    author_id: String,
) -> Result<(), String> {
    state
        .with_library_service(|service| service.delete_author(&account.actor(), &author_id))
        .map_err(|error| error.to_string())
}

/// Result of [`clb_cmd_delete_books`]. The books are gone from the library
/// either way; `trash_failures` lists folder paths and errors for files
/// that could not be moved to the system trash.
#[derive(serde::Serialize, specta::Type)]
pub struct DeleteBooksOutcome {
    pub deleted: u32,
    pub trash_failures: Vec<String>,
}

/// Delete books from the library. The database rows go first, in one
/// transaction (nothing is deleted if any id is unknown); each book's folder
/// is then moved to the system trash rather than erased, so it can be
/// recovered. An author folder left empty by the move is removed, as
/// Calibre does.
#[tauri::command]
#[specta::specta]
pub fn clb_cmd_delete_books(
    state: tauri::State<CitadelState>,
    book_ids: Vec<String>,
) -> Result<DeleteBooksOutcome, String> {
    let ids = book_ids
        .iter()
        .map(|raw| {
            raw.parse::<i32>()
                .map(libcalibre::BookId::from)
                .map_err(|e| format!("Invalid book id '{raw}': {e}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (library_root, dirs) = state
        .with_library(|lib| -> Result<_, libcalibre::CalibreError> {
            let root = std::path::Path::new(lib.library_path()).canonicalize()?;
            let dirs = lib.delete_books(&ids)?;
            Ok((root, dirs))
        })?
        .map_err(|e| e.to_string())?;

    let trash_failures = dirs
        .iter()
        .filter_map(|dir| {
            match super::delete_books::trash_book_dir(&library_root, dir, |path| {
                move_to_trash(path).map_err(|error| error.to_string())
            }) {
                Ok(true) => {
                    remove_empty_author_dir(&library_root, dir);
                    None
                }
                Ok(false) => None,
                Err(e) => {
                    log::warn!("Failed to move {} to the trash: {e}", dir.display());
                    Some(format!("{}: {e}", dir.display()))
                }
            }
        })
        .collect();

    Ok(DeleteBooksOutcome {
        deleted: u32::try_from(dirs.len()).unwrap_or(u32::MAX),
        trash_failures,
    })
}

/// Moves `path` to the system trash. On macOS this uses `NSFileManager`
/// rather than the crate's default Finder/AppleScript route, which would
/// prompt for Automation permission and play the Finder sound.
fn move_to_trash(path: &std::path::Path) -> Result<(), trash::Error> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut context = trash::TrashContext::default();
        context.set_delete_method(DeleteMethod::NsFileManager);
        context.delete(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(path)
    }
}

/// Removes `book_dir`'s parent (the author folder) if it is now empty and
/// sits inside the library. `remove_dir` refuses non-empty directories, so
/// this never deletes anything but an empty folder.
fn remove_empty_author_dir(library_root: &std::path::Path, book_dir: &std::path::Path) {
    let Some(author_dir) = book_dir.parent() else {
        return;
    };
    if author_dir == library_root || !author_dir.starts_with(library_root) {
        return;
    }
    let _ = std::fs::remove_dir(author_dir);
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_create_authors(
    state: tauri::State<CitadelState>,
    account: tauri::State<LocalAccount>,
    new_authors: Vec<NewAuthor>,
) -> Result<Vec<LibraryAuthor>, String> {
    state
        .with_library_service(|service| service.create_authors(&account.actor(), new_authors))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod cover_download_tests {
    use super::*;
    use std::{path::Path, sync::Arc, time::Duration};
    use tokio::sync::Notify;

    fn fixture() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        let archive = std::fs::File::open(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/empty_7_2_calibre_lib.zip"),
        )
        .unwrap();
        zip::ZipArchive::new(archive)
            .unwrap()
            .extract(directory.path())
            .unwrap();
        let database = libcalibre::util::get_db_path(directory.path().to_str().unwrap()).unwrap();
        let mut library = libcalibre::Library::new(database).unwrap();
        library
            .add_book(libcalibre::BookAdd {
                title: "Cover Target".into(),
                author_names: vec!["Author".into()],
                tags: None,
                series: None,
                series_index: None,
                publisher: None,
                publication_date: None,
                rating: None,
                comments: None,
                identifiers: Default::default(),
                language: None,
                file_paths: Vec::new(),
            })
            .unwrap();
        directory
    }

    #[tokio::test]
    async fn download_cannot_apply_its_cover_to_a_newly_selected_library() {
        use axum::{routing::get, Router};
        let a = fixture();
        let b = fixture();
        let state = CitadelState::new();
        state
            .init_library(a.path().to_str().unwrap().into())
            .unwrap();
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let app = Router::new().route(
            "/cover",
            get({
                let started = started.clone();
                let release = release.clone();
                move || {
                    let started = started.clone();
                    let release = release.clone();
                    async move {
                        started.notify_one();
                        release.notified().await;
                        "downloaded cover"
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/cover", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let download = tokio::spawn({
            let state = state.clone();
            async move {
                download_book_cover(
                    &state,
                    &Actor::User { id: "test".into() },
                    "1".into(),
                    url,
                    &reqwest::Client::builder().no_proxy().build().unwrap(),
                )
                .await
            }
        });
        tokio::time::timeout(Duration::from_secs(10), started.notified())
            .await
            .unwrap();
        state
            .init_library(b.path().to_str().unwrap().into())
            .unwrap();
        release.notify_one();
        let result = download.await.unwrap();
        server.abort();
        assert!(result.unwrap_err().contains("Library changed"));
        assert!(!state
            .with_library(|library| library
                .get_book(libcalibre::BookId::from(1))
                .unwrap()
                .has_cover)
            .unwrap());
        let database = libcalibre::util::get_db_path(a.path().to_str().unwrap()).unwrap();
        assert!(
            !libcalibre::Library::open_read_only(database)
                .unwrap()
                .get_book(libcalibre::BookId::from(1))
                .unwrap()
                .has_cover
        );
    }
}
