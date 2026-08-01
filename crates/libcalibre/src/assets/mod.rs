use crate::CalibreError;
use std::path::Path;

use std::path::PathBuf;

pub const COVER_FILENAME: &str = "cover.jpg";

// Generic operations that just need paths
pub fn read(path: &Path) -> Result<Vec<u8>, CalibreError> {
    std::fs::read(path).map_err(|e| CalibreError::FileSystem(e.to_string()))
}

pub fn write(path: &Path, data: &[u8]) -> Result<(), CalibreError> {
    std::fs::write(path, data).map_err(|e| CalibreError::FileSystem(e.to_string()))
}

pub fn asset_path(library_root: &str, book_path: &str, filename: &str) -> PathBuf {
    let library_path = Path::new(library_root);
    library_path.join(book_path).join(filename)
}
