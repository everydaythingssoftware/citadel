//! The library registry, keyed by Calibre library UUID.
use std::path::Path;

use diesel::{prelude::*, sqlite::SqliteConnection};

use super::{schema::libraries, unix_now, CitadelStore, Result, StoreError};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegisteredLibrary {
    pub id: String,
    pub path: String,
    pub display_name: String,
}

impl CitadelStore {
    /// Records where the library with this Calibre UUID lives. Idempotent; a
    /// library that moved keeps its ID, and with it its grants. New libraries
    /// are named after their folder unless `display_name` is given.
    pub fn register_library(
        &self,
        id: &str,
        path: &Path,
        display_name: Option<&str>,
    ) -> Result<RegisteredLibrary> {
        if id.trim().is_empty() {
            return Err(StoreError::Invalid("Library has no Calibre UUID.".into()));
        }
        let path = path
            .canonicalize()
            .map_err(|error| {
                StoreError::Invalid(format!("libraryPath {}: {error}", path.display()))
            })?
            .to_str()
            .ok_or_else(|| StoreError::Invalid("libraryPath must be valid UTF-8".into()))?
            .to_string();
        let display_name = display_name.map(validate_library_name).transpose()?;
        let folder_name = Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Library")
            .to_string();
        let mut connection = self.connection();
        connection.immediate_transaction(|connection| {
            let updated = diesel::update(libraries::table.filter(libraries::id.eq(id)))
                .set(libraries::path.eq(&path))
                .execute(connection)?;
            if updated == 0 {
                diesel::insert_into(libraries::table)
                    .values((
                        libraries::id.eq(id),
                        libraries::path.eq(&path),
                        libraries::display_name.eq(display_name.as_ref().unwrap_or(&folder_name)),
                        libraries::created_at.eq(unix_now()),
                    ))
                    .execute(connection)?;
            } else if let Some(display_name) = &display_name {
                diesel::update(libraries::table.filter(libraries::id.eq(id)))
                    .set(libraries::display_name.eq(display_name))
                    .execute(connection)?;
            }
            Ok::<_, StoreError>(())
        })?;
        library(&mut connection, id)
    }

    pub fn rename_library(&self, id: &str, display_name: &str) -> Result<RegisteredLibrary> {
        let display_name = validate_library_name(display_name)?;
        let mut connection = self.connection();
        known_library(&mut connection, id)?;
        diesel::update(libraries::table.filter(libraries::id.eq(id)))
            .set(libraries::display_name.eq(&display_name))
            .execute(&mut *connection)?;
        library(&mut connection, id)
    }

    pub fn libraries(&self) -> Result<Vec<RegisteredLibrary>> {
        Ok(libraries::table
            .order(libraries::created_at)
            .select((libraries::id, libraries::path, libraries::display_name))
            .load::<(String, String, String)>(&mut *self.connection())?
            .into_iter()
            .map(|(id, path, display_name)| RegisteredLibrary {
                id,
                path,
                display_name,
            })
            .collect())
    }
}

fn library(connection: &mut SqliteConnection, id: &str) -> Result<RegisteredLibrary> {
    libraries::table
        .filter(libraries::id.eq(id))
        .select((libraries::id, libraries::path, libraries::display_name))
        .first::<(String, String, String)>(connection)
        .optional()?
        .map(|(id, path, display_name)| RegisteredLibrary {
            id,
            path,
            display_name,
        })
        .ok_or_else(|| StoreError::NotFound(format!("No library has ID '{id}'.")))
}

pub(super) fn known_library(connection: &mut SqliteConnection, library_id: &str) -> Result<()> {
    let exists: bool = diesel::select(diesel::dsl::exists(
        libraries::table.filter(libraries::id.eq(library_id)),
    ))
    .get_result(connection)?;
    exists
        .then_some(())
        .ok_or_else(|| StoreError::NotFound(format!("No library has ID '{library_id}'.")))
}

fn validate_library_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(StoreError::Invalid("Library name cannot be empty".into()));
    }
    Ok(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{store, LIBRARY_ID};
    use super::*;

    #[test]
    fn libraries_are_keyed_by_calibre_uuid_and_keep_grants_when_moved() {
        let (directory, store, library) = store();
        assert_eq!(library.id, LIBRARY_ID);
        assert_eq!(
            store
                .register_library(
                    LIBRARY_ID,
                    &directory.path().join("library/../library"),
                    None
                )
                .unwrap(),
            library
        );
        store.create_user("alice", "correct horse").unwrap();
        store.grant("alice", LIBRARY_ID).unwrap();
        std::fs::rename(
            directory.path().join("library"),
            directory.path().join("moved"),
        )
        .unwrap();
        let moved = store
            .register_library(LIBRARY_ID, &directory.path().join("moved"), None)
            .unwrap();
        assert!(moved.path.ends_with("moved"));
        drop(store);
        let reopened = CitadelStore::open(&directory.path().join("citadel.db")).unwrap();
        assert_eq!(reopened.libraries().unwrap(), vec![moved.clone()]);
        assert_eq!(reopened.app_credentials(LIBRARY_ID).unwrap().len(), 1);
        assert_eq!(moved.display_name, "library");
        assert!(reopened
            .register_library(" ", directory.path(), None)
            .is_err());
        let renamed = reopened.rename_library(LIBRARY_ID, " Fiction ").unwrap();
        assert_eq!(renamed.display_name, "Fiction");
        assert!(reopened.rename_library(LIBRARY_ID, " ").is_err());
        let named = reopened
            .register_library(LIBRARY_ID, &directory.path().join("moved"), Some("Shelf"))
            .unwrap();
        assert_eq!(named.display_name, "Shelf");
    }
}
