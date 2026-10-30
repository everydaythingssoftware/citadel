use crate::state::CitadelState;

use serde::Serialize;

pub mod command;
pub mod onboarding;
pub mod query;
pub mod registry;

#[derive(Serialize, specta::Type)]
pub struct CalibreClientConfig {
    library_path: String,
}

#[tauri::command]
#[specta::specta]
pub async fn init_client(
    handle: tauri::AppHandle,
    state: tauri::State<'_, CitadelState>,
    library_path: String,
) -> Result<CalibreClientConfig, String> {
    use tauri::Manager;

    // Stop BEFORE the swap: the running server reads live state, so draining
    // after the swap would serve the new library under the old share. If the
    // new library then fails to open, sharing stays off - the right failure
    // direction (better a dead share than a wrong one). Re-opening the
    // already-active library keeps sharing.
    let same_library = state.get_library_path().as_deref() == Some(library_path.as_str());
    if !same_library {
        handle.state::<citadel_opds::OpdsService>().stop().await;
    }

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
