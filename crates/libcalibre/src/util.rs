use std::path::Path;

use crate::CalibreError;

#[derive(Clone)]
pub(crate) struct ValidDbPath {
    pub(crate) library_path: String,
    pub(crate) database_path: String,
}

impl ValidDbPath {
    /// The library rooted at `library_root`, which must hold a `metadata.db`.
    pub(crate) fn locate(library_root: &Path) -> Result<Self, CalibreError> {
        let database = library_root.join("metadata.db");
        if !database.is_file() {
            return Err(CalibreError::NotALibrary(library_root.to_path_buf()));
        }
        let utf8 = |path: &Path| {
            path.to_str()
                .map(str::to_string)
                .ok_or_else(|| CalibreError::NonUtf8Path(path.to_path_buf()))
        };
        Ok(Self {
            library_path: utf8(library_root)?,
            database_path: utf8(&database)?,
        })
    }
}

/// Whether `library_root` holds a Calibre library (a `metadata.db` file).
/// Nothing is opened or read.
pub fn is_library(library_root: impl AsRef<Path>) -> bool {
    library_root.as_ref().join("metadata.db").is_file()
}
