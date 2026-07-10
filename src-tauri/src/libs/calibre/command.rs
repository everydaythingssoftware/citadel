use tauri::Manager;

use crate::book::ImportableBookMetadata;
use crate::book::LibraryAuthor;
use crate::calibre::author::NewAuthor;
use crate::libs::cover_thumbs::{self, CoverThumbnail};
use crate::state::CitadelState;

use super::custom_columns::CustomValueDto;
use super::onboarding::{self, CreateTargetBlocker};
use super::AuthorUpdate;
use super::BookUpdate;

/// Exact error strings `clb_cmd_create_library` returns when it refuses the
/// target folder. The frontend matches on them to offer alternatives: "open
/// it instead" for an existing library, "pick another folder" for content.
pub const ERR_CREATE_LIBRARY_TARGET_IS_LIBRARY: &str = "create-library/already-a-library";
pub const ERR_CREATE_LIBRARY_TARGET_NOT_EMPTY: &str = "create-library/folder-not-empty";

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_update_book(
    state: tauri::State<CitadelState>,
    book_id: String,
    updates: BookUpdate,
) -> Result<i32, String> {
    state.with_library(|lib| {
        let book_id_int = book_id.parse::<i32>().map_err(|e| e.to_string())?;
        lib.update_book(
            libcalibre::BookId::from(book_id_int),
            updates.to_library_update(),
        )
        .map(|entry| entry.id.as_i32())
        .map_err(|e| e.to_string())
    })?
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_set_custom_value(
    state: tauri::State<CitadelState>,
    book_id: String,
    column_id: i32,
    value: Option<CustomValueDto>,
) -> Result<(), String> {
    state.with_library(|lib| {
        let book_id_int = book_id.parse::<i32>().map_err(|e| e.to_string())?;
        let value = value.map(libcalibre::CustomValue::try_from).transpose()?;
        lib.set_custom_value(libcalibre::BookId::from(book_id_int), column_id, value)
            .map_err(|e| e.to_string())
    })?
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
    md: ImportableBookMetadata,
) -> Result<String, String> {
    state.with_library(|lib| {
        let book_add = md.to_book_add();
        lib.add_book(book_add)
            .map(|book| book.id.as_i32().to_string())
            .map_err(|e| e.to_string())
    })?
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_upsert_book_identifier(
    state: tauri::State<CitadelState>,
    book_id: String,
    label: String,
    value: String,
    existing_id: Option<i32>,
) -> Result<(), String> {
    state.with_library(|lib| {
        let book_id_int = book_id.parse::<i32>().map_err(|e| e.to_string())?;
        lib.upsert_book_identifier(
            libcalibre::BookId::from(book_id_int),
            label,
            value,
            existing_id,
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    })?
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_delete_book_identifier(
    state: tauri::State<CitadelState>,
    book_id: String,
    identifier_id: i32,
) -> Result<(), String> {
    state.with_library(|lib| {
        let book_id_int = book_id.parse::<i32>().map_err(|e| e.to_string())?;
        lib.delete_book_identifier(libcalibre::BookId::from(book_id_int), identifier_id)
            .map_err(|e| e.to_string())
    })?
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_set_book_cover_from_url(
    state: tauri::State<'_, CitadelState>,
    book_id: String,
    image_url: String,
) -> Result<(), String> {
    let book_id_int = book_id.parse::<i32>().map_err(|e| e.to_string())?;
    let image_url = image_url.trim();
    if image_url.is_empty() {
        return Err("Image URL is empty".to_string());
    }

    let response = reqwest::Client::new()
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

    state.with_library(|lib| {
        lib.set_book_cover(libcalibre::BookId::from(book_id_int), bytes.to_vec())
            .map_err(|e| e.to_string())
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
    author_id: String,
    updates: AuthorUpdate,
) -> Result<i32, String> {
    state.with_library(|lib| {
        let author_id_int = author_id.parse::<i32>().map_err(|e| e.to_string())?;
        lib.update_author(
            libcalibre::AuthorId::from(author_id_int),
            updates.to_library_update(),
        )
        .map(|entry| entry.id.as_i32())
        .map_err(|e| e.to_string())
    })?
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_delete_author(
    state: tauri::State<CitadelState>,
    author_id: String,
) -> Result<(), String> {
    state.with_library(|lib| {
        let author_id_int = author_id.parse::<i32>().map_err(|e| e.to_string())?;
        lib.remove_author(libcalibre::AuthorId::from(author_id_int))
            .map(|_| ())
            .map_err(|e| e.to_string())
    })?
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_create_authors(
    state: tauri::State<CitadelState>,
    new_authors: Vec<NewAuthor>,
) -> Result<Vec<LibraryAuthor>, String> {
    state.with_library(|lib| {
        // Freshly created authors have no linked books yet, so an empty
        // counts map is exact (from_author defaults missing entries to 0).
        let no_book_counts = std::collections::HashMap::new();
        let mut created = Vec::new();
        for author in &new_authors {
            let author_add = libcalibre::AuthorAdd {
                name: author.name.clone(),
                sort: author.sortable_name.clone(),
                link: None,
            };
            let author_id = lib.add_author(author_add).map_err(|e| e.to_string())?;
            let library_author = lib.get_author(author_id).map_err(|e| e.to_string())?;
            created.push(LibraryAuthor::from_author(&library_author, &no_book_counts));
        }
        Ok(created)
    })?
}
