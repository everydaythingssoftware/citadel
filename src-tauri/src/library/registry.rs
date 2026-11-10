//! The desktop's library list, kept in `citadel.db` and keyed by each
//! library's Calibre UUID (ADR 0009). Every change is broadcast so all
//! windows show the same list.
use serde::{Deserialize, Serialize};
use tauri_specta::Event;

use crate::account::LocalAccount;
use citadel_core::store::RegisteredLibrary;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub id: String,
    pub display_name: String,
    pub absolute_path: String,
}

impl From<RegisteredLibrary> for LibraryEntry {
    fn from(library: RegisteredLibrary) -> Self {
        Self {
            id: library.id,
            display_name: library.display_name,
            absolute_path: library.path,
        }
    }
}

/// The full library list after any change, for every window.
#[derive(Clone, Debug, Deserialize, Serialize, specta::Type, tauri_specta::Event)]
pub struct LibrariesChanged(pub Vec<LibraryEntry>);

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryIdChange {
    pub previous_id: String,
    pub id: String,
}

/// Result of moving a pre-CDL-45 `settings.json` library list into the registry.
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LegacyLibraryImport {
    pub libraries: Vec<LibraryEntry>,
    pub id_changes: Vec<LibraryIdChange>,
    /// Entries whose folder no longer holds a readable Calibre library.
    pub dropped: Vec<LibraryEntry>,
}

fn calibre_uuid(path: &str) -> Result<String, String> {
    let database = libcalibre::util::get_db_path(path)
        .ok_or_else(|| format!("Not a Calibre library: {path}"))?;
    libcalibre::Library::open_read_only(database)
        .and_then(|mut library| library.library_uuid())
        .map_err(|error| format!("Could not read library at {path}: {error}"))
}

fn register(
    account: &LocalAccount,
    path: &str,
    display_name: Option<&str>,
) -> Result<LibraryEntry, String> {
    let id = calibre_uuid(path)?;
    let library = account
        .store()
        .register_library(&id, std::path::Path::new(path), display_name)
        .map_err(|error| error.to_string())?;
    let user = account.user()?;
    account
        .store()
        .grant(&user.username, &library.id)
        .map_err(|error| error.to_string())?;
    Ok(library.into())
}

fn list(account: &LocalAccount) -> Result<Vec<LibraryEntry>, String> {
    Ok(account
        .store()
        .libraries()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(LibraryEntry::from)
        .collect())
}

fn broadcast(handle: &tauri::AppHandle, account: &LocalAccount) -> Result<(), String> {
    LibrariesChanged(list(account)?)
        .emit(handle)
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_libraries(
    account: tauri::State<'_, LocalAccount>,
) -> Result<Vec<LibraryEntry>, String> {
    list(&account)
}

/// Adds a library by folder, or returns the existing entry for its Calibre
/// UUID (updating its path if the library moved).
#[tauri::command]
#[specta::specta]
pub fn clb_cmd_register_library(
    handle: tauri::AppHandle,
    account: tauri::State<'_, LocalAccount>,
    absolute_path: String,
) -> Result<LibraryEntry, String> {
    let library = register(&account, &absolute_path, None)?;
    broadcast(&handle, &account)?;
    Ok(library)
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_rename_library(
    handle: tauri::AppHandle,
    account: tauri::State<'_, LocalAccount>,
    id: String,
    display_name: String,
) -> Result<LibraryEntry, String> {
    let library = account
        .store()
        .rename_library(&id, &display_name)
        .map_err(|error| error.to_string())?;
    broadcast(&handle, &account)?;
    Ok(library.into())
}

/// Forgets a library, and its grants, without touching its folder.
#[tauri::command]
#[specta::specta]
pub fn clb_cmd_remove_library(
    handle: tauri::AppHandle,
    account: tauri::State<'_, LocalAccount>,
    id: String,
) -> Result<(), String> {
    account
        .store()
        .remove_library(&id)
        .map_err(|error| error.to_string())?;
    broadcast(&handle, &account)
}

#[tauri::command]
#[specta::specta]
pub fn clb_cmd_import_legacy_libraries(
    handle: tauri::AppHandle,
    account: tauri::State<'_, LocalAccount>,
    entries: Vec<LibraryEntry>,
) -> Result<LegacyLibraryImport, String> {
    let result = import_legacy(&account, entries)?;
    broadcast(&handle, &account)?;
    Ok(result)
}

fn import_legacy(
    account: &LocalAccount,
    entries: Vec<LibraryEntry>,
) -> Result<LegacyLibraryImport, String> {
    let mut id_changes = Vec::new();
    let mut dropped = Vec::new();
    for entry in entries {
        match register(account, &entry.absolute_path, Some(&entry.display_name)) {
            Ok(library) => id_changes.push(LibraryIdChange {
                previous_id: entry.id,
                id: library.id,
            }),
            Err(_) => dropped.push(entry),
        }
    }
    Ok(LegacyLibraryImport {
        libraries: list(account)?,
        id_changes,
        dropped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library(directory: &std::path::Path, name: &str) -> String {
        let path = directory.join(name);
        drop(libcalibre::Library::create_library_at(path.to_str().unwrap()).unwrap());
        path.to_str().unwrap().to_string()
    }

    #[test]
    fn legacy_entries_move_to_calibre_ids_and_missing_folders_are_dropped() {
        let directory = tempfile::tempdir().unwrap();
        let account = LocalAccount::open(&directory.path().join("app")).unwrap();
        let fiction = library(directory.path(), "fiction");
        let result = import_legacy(
            &account,
            vec![
                LibraryEntry {
                    id: "settings-1".into(),
                    display_name: "Fiction".into(),
                    absolute_path: fiction.clone(),
                },
                LibraryEntry {
                    id: "settings-2".into(),
                    display_name: "Gone".into(),
                    absolute_path: directory.path().join("gone").display().to_string(),
                },
            ],
        )
        .unwrap();
        let calibre_id = calibre_uuid(&fiction).unwrap();
        assert_eq!(result.libraries.len(), 1);
        assert_eq!(result.libraries[0].id, calibre_id);
        assert_eq!(result.libraries[0].display_name, "Fiction");
        assert_eq!(result.id_changes[0].previous_id, "settings-1");
        assert_eq!(result.id_changes[0].id, calibre_id);
        assert_eq!(result.dropped[0].display_name, "Gone");
        let user = account.user().unwrap();
        assert!(account.store().can_access(&user.id, &calibre_id).unwrap());

        let again = register(&account, &fiction, None).unwrap();
        assert_eq!(again.display_name, "Fiction");
        assert_eq!(list(&account).unwrap().len(), 1);
        assert!(register(&account, directory.path().to_str().unwrap(), None).is_err());
    }
}
