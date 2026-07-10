use std::path::PathBuf;

use crate::state::CitadelState;

use chrono::NaiveDateTime;
use serde::Deserialize;
use serde::Serialize;

mod author;
mod book;

pub mod command;
pub mod custom_columns;
pub mod onboarding;
pub mod query;

#[derive(Serialize, Deserialize, specta::Type, Debug)]
pub struct ImportableFile {
    pub(crate) path: PathBuf,
}

#[derive(Serialize, specta::Type)]
pub struct CalibreClientConfig {
    library_path: String,
}

#[tauri::command]
#[specta::specta]
pub fn init_client(
    handle: tauri::AppHandle,
    state: tauri::State<CitadelState>,
    library_path: String,
) -> Result<CalibreClientConfig, String> {
    use tauri::Manager;

    state.init_library(library_path.clone())?;

    // Full-resolution covers are served over the asset protocol straight from
    // the library folder. Without this grant they only render when the folder
    // was picked through a dialog this install (persisted scope), so covers
    // break for restored/hand-edited settings.
    handle
        .asset_protocol_scope()
        .allow_directory(&library_path, true)
        .map_err(|e| format!("Failed to allow library dir: {}", e))?;

    Ok(CalibreClientConfig { library_path })
}

#[derive(Serialize, Deserialize, specta::Type, Debug)]
pub struct BookUpdate {
    pub author_id_list: Option<Vec<String>>,
    pub tag_list: Option<Vec<String>>,
    pub title: Option<String>,
    pub timestamp: Option<NaiveDateTime>,
    pub publication_date: Option<NaiveDateTime>,
    pub is_read: Option<bool>,
    pub description: Option<String>,
    /// An empty (or whitespace) name unlinks the book from its series;
    /// `None` leaves it unchanged.
    pub series: Option<String>,
    pub series_index: Option<f32>,
    /// Language codes to write through to `books_languages_link` (canonicalized
    /// to Calibre's ISO 639-2/3 form). An empty list clears the book's
    /// languages; `None` leaves them unchanged.
    pub language_list: Option<Vec<String>>,
}

impl BookUpdate {
    pub fn to_library_update(&self) -> libcalibre::BookUpdate {
        libcalibre::BookUpdate {
            title: self.title.clone(),
            author_names: None,
            author_ids: self.author_id_list.as_ref().map(|ids| {
                ids.iter()
                    .filter_map(|id| id.parse::<i32>().ok())
                    .map(libcalibre::AuthorId::from)
                    .collect()
            }),
            description: self.description.clone(),
            is_read: self.is_read,
            publication_date: self.publication_date.map(|dt| dt.date()),
            tags: self.tag_list.clone(),
            series: self.series.clone(),
            series_index: self.series_index,
            language_codes: self.language_list.clone(),
            publisher: None,
            rating: None,
            comments: None,
            identifiers: None,
        }
    }
}

#[derive(Serialize, Deserialize, specta::Type, Debug)]
pub struct AuthorUpdate {
    pub full_name: Option<String>,
    pub sortable_name: Option<String>,
    pub external_url: Option<String>,
}

impl AuthorUpdate {
    pub fn to_library_update(&self) -> libcalibre::AuthorUpdate {
        libcalibre::AuthorUpdate {
            name: self.full_name.clone(),
            sort: self.sortable_name.clone(),
            link: self.external_url.clone(),
        }
    }
}
