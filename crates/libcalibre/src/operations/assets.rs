use std::path::{Path, PathBuf};

use diesel::{Connection, SqliteConnection};

use crate::{
    assets::{self, COVER_FILENAME},
    queries::{authors, book_descriptions, book_files, book_identifiers, books},
    types::BookId,
    CalibreError, UpdateBookData,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedBookAsset {
    canonical_path: PathBuf,
    download_name: String,
    format: String,
}

impl ResolvedBookAsset {
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }

    pub fn download_name(&self) -> &str {
        &self.download_name
    }

    pub fn format(&self) -> &str {
        &self.format
    }
}

fn canonical_asset(library_root: &str, path: PathBuf) -> Result<PathBuf, CalibreError> {
    let canonical_root = Path::new(library_root).canonicalize()?;
    let canonical_path = match path.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(CalibreError::AssetFileMissing(path));
        }
        Err(error) => return Err(CalibreError::IoError(error)),
    };

    if !canonical_path.starts_with(canonical_root) {
        return Err(CalibreError::AssetOutsideLibrary);
    }

    Ok(canonical_path)
}

fn normalized_format(file_format: &str) -> Result<String, CalibreError> {
    let trimmed = file_format.trim();
    let normalized = trimmed
        .strip_prefix('.')
        .unwrap_or(trimmed)
        .to_ascii_uppercase();
    if normalized.is_empty() || !normalized.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(CalibreError::InvalidBookFormat(file_format.to_string()));
    }
    Ok(normalized)
}

pub(crate) fn is_resolvable_book_file(
    library_root: &str,
    book_path: &str,
    file_name: &str,
    file_format: &str,
) -> bool {
    let Ok(format) = normalized_format(file_format) else {
        return false;
    };
    let download_name = format!("{}.{}", file_name, format.to_ascii_lowercase());
    let path = assets::asset_path(library_root, book_path, &download_name);
    canonical_asset(library_root, path).is_ok()
}

pub(crate) fn is_resolvable_book_cover(library_root: &str, book_path: &str) -> bool {
    let path = assets::asset_path(library_root, book_path, COVER_FILENAME);
    canonical_asset(library_root, path).is_ok()
}

pub fn resolve_book_cover(
    library_root: &str,
    conn: &mut SqliteConnection,
    book_id: BookId,
) -> Result<ResolvedBookAsset, CalibreError> {
    let book = books::get(conn, book_id)?.ok_or(CalibreError::BookNotFound(book_id))?;
    if book.has_cover != Some(true) {
        return Err(CalibreError::BookCoverNotFound(book_id));
    }

    let path = assets::asset_path(library_root, &book.path, COVER_FILENAME);
    Ok(ResolvedBookAsset {
        canonical_path: canonical_asset(library_root, path)?,
        download_name: COVER_FILENAME.to_string(),
        format: "JPG".to_string(),
    })
}

pub fn resolve_book_file(
    library_root: &str,
    conn: &mut SqliteConnection,
    book_id: BookId,
    file_format: &str,
) -> Result<ResolvedBookAsset, CalibreError> {
    let book = books::get(conn, book_id)?.ok_or(CalibreError::BookNotFound(book_id))?;
    let requested_format = normalized_format(file_format)?;
    let file = book_files::find_by_book_and_format(conn, book_id, requested_format.clone())?
        .ok_or_else(|| CalibreError::BookFileNotFound(book_id, requested_format.clone()))?;
    let stored_format = file.format.to_ascii_uppercase();
    let download_name = format!("{}.{}", file.name, stored_format.to_ascii_lowercase());
    let path = assets::asset_path(library_root, &book.path, &download_name);

    Ok(ResolvedBookAsset {
        canonical_path: canonical_asset(library_root, path)?,
        download_name,
        format: stored_format,
    })
}

pub fn get_book_cover(
    library_root: &str,
    conn: &mut SqliteConnection,
    book_id: BookId,
) -> Result<Vec<u8>, CalibreError> {
    let asset = resolve_book_cover(library_root, conn, book_id)?;
    assets::read(asset.canonical_path())
}

pub fn get_book_file_path(
    library_root: &str,
    conn: &mut SqliteConnection,
    book_id: BookId,
    file_format: &str,
) -> Result<std::path::PathBuf, CalibreError> {
    resolve_book_file(library_root, conn, book_id, file_format).map(|asset| asset.canonical_path)
}

pub fn get_book_file(
    library_root: &str,
    conn: &mut SqliteConnection,
    book_id: BookId,
    file_format: &str,
) -> Result<Vec<u8>, CalibreError> {
    let file_path = get_book_file_path(library_root, conn, book_id, file_format)?;
    assets::read(&file_path)
}

pub fn add_book_file_from_bytes(
    library_root: &str,
    conn: &mut SqliteConnection,
    book_id: BookId,
    file_format: String,
    data: Vec<u8>,
) -> Result<(), CalibreError> {
    let book = books::get(conn, book_id)?.ok_or(CalibreError::BookNotFound(book_id))?;

    let book_filename = filename(book.path.clone(), file_format.clone());
    let file_path = assets::asset_path(library_root, &book.path, &book_filename);
    assets::write(&file_path, &data)?;

    let new_file = crate::entities::book_file::NewBookFile {
        book: book_id.as_i32(),
        format: file_format.to_uppercase(),
        uncompressed_size: data.len() as i32,
        name: book.path.clone(),
    };

    match book_files::create(conn, new_file) {
        Ok(_) => {
            books::touch(conn, book_id)?;
            Ok(())
        }
        Err(e) => {
            // If database entry fails, remove the written file
            let _ = std::fs::remove_file(&file_path);
            Err(e)
        }
    }
}

pub fn add_book_file_from_path(
    library_root: &str,
    conn: &mut SqliteConnection,
    book_id: BookId,
    file_format: String,
    file_path: String,
) -> Result<(), CalibreError> {
    let book = books::get(conn, book_id)?.ok_or(CalibreError::BookNotFound(book_id))?;

    let book_filename = filename(book.path.clone(), file_format.clone());
    let dest_path = assets::asset_path(library_root, &book.path, &book_filename);
    std::fs::copy(file_path, &dest_path).map_err(|e| CalibreError::FileSystem(e.to_string()))?;

    // Get file size for database
    let metadata =
        std::fs::metadata(&dest_path).map_err(|e| CalibreError::FileSystem(e.to_string()))?;

    let new_file = crate::entities::book_file::NewBookFile {
        book: book_id.as_i32(),
        format: file_format.to_uppercase(),
        uncompressed_size: metadata.len() as i32,
        name: book.path.clone(),
    };

    match book_files::create(conn, new_file) {
        Ok(_) => {
            books::touch(conn, book_id)?;
            Ok(())
        }
        Err(e) => {
            // If database entry fails, remove the copied file
            let _ = std::fs::remove_file(&dest_path);
            Err(e)
        }
    }
}

pub fn set_book_cover(
    library_root: &str,
    conn: &mut SqliteConnection,
    book_id: BookId,
    cover_data: Vec<u8>,
) -> Result<(), CalibreError> {
    conn.transaction::<(), CalibreError, _>(|conn| {
        let book = books::get(conn, book_id)?.ok_or(CalibreError::BookNotFound(book_id))?;
        let cover_path = assets::asset_path(library_root, &book.path, COVER_FILENAME);

        assets::write(&cover_path, &cover_data)?;

        let update = UpdateBookData {
            has_cover: Some(true),
            ..Default::default()
        };
        books::update(conn, book_id, update)?;
        books::touch(conn, book_id)?;
        Ok(())
    })
}

pub fn remove_book_file(
    library_root: &str,
    conn: &mut SqliteConnection,
    book_id: BookId,
    file_format: &str,
) -> Result<(), CalibreError> {
    conn.transaction::<(), CalibreError, _>(|conn| {
        let book = books::get(conn, book_id)?.ok_or(CalibreError::BookNotFound(book_id))?;

        let file =
            book_files::find_by_book_and_format(conn, book_id, file_format.to_string())?.ok_or(
                CalibreError::BookFileNotFound(book_id, file_format.to_string()),
            )?;

        let all_files = book_files::find_by_book_id(conn, book_id)?;
        let is_last_format = all_files.len() == 1;

        if is_last_format {
            delete_entire_book(library_root, conn, book_id, &book.path)?;
        } else {
            book_files::delete(conn, crate::types::BookFileId(file.id))?;

            let book_filename = filename(book.path.clone(), file_format.to_string());
            let file_path = assets::asset_path(library_root, &book.path, &book_filename);

            match std::fs::remove_file(&file_path) {
                Ok(_) => {}
                Err(e) => {
                    eprintln!("WARNING: Failed to delete file {:?}: {}", file_path, e);
                }
            }
            books::touch(conn, book_id)?;
        }

        Ok(())
    })
}

pub(crate) fn delete_entire_book(
    library_root: &str,
    conn: &mut SqliteConnection,
    book_id: BookId,
    book_path: &str,
) -> Result<(), CalibreError> {
    book_files::delete_all(conn, book_id)?;

    book_descriptions::delete(conn, book_id)?;

    book_identifiers::delete_all(conn, book_id)?;

    let author_ids = books::find_authors(conn, book_id)?;
    for author_id in author_ids {
        authors::unlink_book(conn, author_id, book_id)?;
    }

    books::delete(conn, book_id)?;
    books::touch_catalog(conn)?;

    let book_dir = std::path::Path::new(library_root).join(book_path);
    match std::fs::remove_dir_all(&book_dir) {
        Ok(_) => {}
        Err(e) => {
            eprintln!(
                "WARNING: Failed to delete book directory {:?}: {}",
                book_dir, e
            );
        }
    }

    Ok(())
}

fn filename(book_path: String, file_format: String) -> String {
    let ext = file_format.to_lowercase();
    let base_name = book_path;

    if ext.is_empty() {
        base_name
    } else {
        format!("{}.{}", base_name, ext)
    }
}
