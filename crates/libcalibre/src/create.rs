//! Making a library: what a target folder may already hold, and the library
//! itself.
use std::path::Path;

use diesel::{Connection, SqliteConnection};

use crate::{error::CalibreError, schema_versions, util::get_db_path, Library};

/// Why a folder can't take a new library.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateTargetBlocker {
    /// Target already contains a `metadata.db`; hosts offer "open it instead".
    AlreadyALibrary,
    /// Target exists and holds real (non-junk) content, or is a file.
    NotEmpty,
}

/// OS droppings that don't make a folder "non-empty". Compared
/// case-insensitively; `Thumbs.db`/`desktop.ini` casing varies on Windows.
const JUNK_FILES: &[&str] = &[".ds_store", ".localized", "thumbs.db", "desktop.ini"];

fn is_junk(file_name: &str) -> bool {
    JUNK_FILES.contains(&file_name.to_ascii_lowercase().as_str())
}

/// A missing target is fine (creation makes the folder); an existing one must
/// be an empty-ish directory. IO errors (e.g. unreadable folder) propagate:
/// emptiness can't be verified, so creation must not proceed.
pub fn create_target_blocker(target: &Path) -> std::io::Result<Option<CreateTargetBlocker>> {
    if !target.exists() {
        return Ok(None);
    }
    if target.join("metadata.db").exists() {
        return Ok(Some(CreateTargetBlocker::AlreadyALibrary));
    }
    if !target.is_dir() {
        return Ok(Some(CreateTargetBlocker::NotEmpty));
    }
    for entry in std::fs::read_dir(target)? {
        if !is_junk(&entry?.file_name().to_string_lossy()) {
            return Ok(Some(CreateTargetBlocker::NotEmpty));
        }
    }
    Ok(None)
}

impl Library {
    /// Creates a Calibre library in `path` (made if missing) at
    /// [`schema_versions::SCHEMA_VERSION`] with a fresh library UUID, and
    /// opens it for writing. Refuses a folder that already holds a
    /// `metadata.db`; callers wanting the fuller emptiness check use
    /// [`create_target_blocker`] first.
    pub fn create_library_at(path: &str) -> Result<Library, CalibreError> {
        let root = Path::new(path);
        let database = root.join("metadata.db");
        if database.exists() {
            return Err(CalibreError::LibraryAlreadyExists(root.to_path_buf()));
        }
        std::fs::create_dir_all(root)?;
        let database_path = database
            .to_str()
            .ok_or_else(|| CalibreError::FileSystem("library path must be valid UTF-8".into()))?;
        let created = SqliteConnection::establish(database_path)
            .map_err(CalibreError::database)
            .and_then(|mut conn| {
                schema_versions::create(&mut conn, &uuid::Uuid::new_v4().to_string())
                    .map_err(CalibreError::from)
            });
        if let Err(error) = created {
            let _ = std::fs::remove_file(&database);
            return Err(error);
        }
        let valid = get_db_path(path).ok_or_else(|| {
            CalibreError::FileSystem(format!("could not find the library just created at {path}"))
        })?;
        Library::new(valid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_target_accepts_missing_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("not-yet");
        assert_eq!(create_target_blocker(&target).unwrap(), None);
    }

    #[test]
    fn create_target_accepts_empty_folder() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(create_target_blocker(tmp.path()).unwrap(), None);
    }

    #[test]
    fn create_target_ignores_junk_files() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".DS_Store"), b"").unwrap();
        std::fs::write(tmp.path().join("Thumbs.db"), b"").unwrap();
        assert_eq!(create_target_blocker(tmp.path()).unwrap(), None);
    }

    #[test]
    fn create_target_refuses_folder_with_content() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("notes.txt"), b"hi").unwrap();
        assert_eq!(
            create_target_blocker(tmp.path()).unwrap(),
            Some(CreateTargetBlocker::NotEmpty)
        );
    }

    #[test]
    fn create_target_flags_existing_library_distinctly() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("metadata.db"), b"").unwrap();
        assert_eq!(
            create_target_blocker(tmp.path()).unwrap(),
            Some(CreateTargetBlocker::AlreadyALibrary)
        );
    }

    #[test]
    fn create_target_refuses_file_target() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("a-file");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(
            create_target_blocker(&file).unwrap(),
            Some(CreateTargetBlocker::NotEmpty)
        );
    }
}
