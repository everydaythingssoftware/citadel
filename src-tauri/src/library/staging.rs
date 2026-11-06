//! Books chosen or dropped on the desktop, read where they are for review
//! before they join the library. Nothing is copied until a book is added;
//! cover previews live in the app cache. Staged books last until they are
//! added or skipped, or the app quits.
use std::{
    collections::HashMap,
    ffi::OsStr,
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::Mutex,
};

use citadel_core::{
    error::{LibraryError, LibraryErrorCode},
    path_to_asset_url,
    staging::{book_format, read_book_file, CommitUpload, StagedBook},
    LibraryBook,
};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, ImageReader, Limits};
use libcalibre::book_file;
use serde::Serialize;

use crate::{account::LocalAccount, state::CitadelState};

/// Inside the app cache directory.
pub const COVER_DIR: &str = "staged-covers";
const COVER_PREVIEW_SIZE: u32 = 600;

/// The books waiting for review, across libraries: each library sees its own.
pub struct DesktopStaging {
    cover_dir: PathBuf,
    books: Mutex<HashMap<String, Staged>>,
}

struct Staged {
    library_id: String,
    path: PathBuf,
    file_name: String,
    size: u64,
    book: StagedBook,
    cover: Option<PathBuf>,
    /// Being added to the library; one add at a time.
    busy: bool,
}

/// A book file read for review, ready to add or skip.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StagedFile {
    id: String,
    file_name: String,
    size: u64,
    book: StagedBook,
}

impl Staged {
    fn view(&self, id: &str) -> StagedFile {
        StagedFile {
            id: id.to_string(),
            file_name: self.file_name.clone(),
            size: self.size,
            book: self.book.clone(),
        }
    }
}

fn not_found() -> LibraryError {
    LibraryError::new(LibraryErrorCode::NotFound, "This book is no longer waiting")
}

fn unavailable(error: impl ToString) -> LibraryError {
    LibraryError::new(LibraryErrorCode::Unavailable, error.to_string())
}

/// A JPEG preview of an embedded cover, decoded within limits.
fn cover_preview(cover: Vec<u8>) -> Option<Vec<u8>> {
    let mut reader = ImageReader::new(Cursor::new(cover))
        .with_guessed_format()
        .ok()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(10000);
    limits.max_image_height = Some(10000);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .ok()?
        .resize(COVER_PREVIEW_SIZE, COVER_PREVIEW_SIZE, FilterType::Triangle)
        .to_rgb8();
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 80)
        .encode_image(&image)
        .ok()?;
    Some(bytes)
}

/// Whether the file's first bytes look like the format its name claims.
fn content_matches(path: &Path, format: libcalibre::mime_type::MIMETYPE) -> bool {
    let mut head = Vec::with_capacity(book_file::CONTENT_CHECK_BYTES);
    fs::File::open(path)
        .and_then(|file| {
            file.take(book_file::CONTENT_CHECK_BYTES as u64)
                .read_to_end(&mut head)
        })
        .is_ok()
        && book_file::content_matches(format, &head)
}

impl DesktopStaging {
    /// Starts empty, clearing previews left by an earlier run.
    pub fn new(cover_dir: PathBuf) -> Self {
        let _ = fs::remove_dir_all(&cover_dir);
        Self {
            cover_dir,
            books: Mutex::new(HashMap::new()),
        }
    }

    pub fn cover_dir(&self) -> &Path {
        &self.cover_dir
    }

    fn books(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, Staged>>, LibraryError> {
        self.books.lock().map_err(unavailable)
    }

    fn list(&self, library_id: &str) -> Result<Vec<StagedFile>, LibraryError> {
        Ok(self
            .books()?
            .iter()
            .filter(|(_, staged)| staged.library_id == library_id)
            .map(|(id, staged)| staged.view(id))
            .collect())
    }

    /// Reads the book at `path` for review in the library `library_id`.
    fn stage(&self, library_id: String, path: PathBuf) -> Result<StagedFile, LibraryError> {
        let file_name = path
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or_else(|| LibraryError::invalid("This file's name can't be read"))?
            .to_string();
        let (extension, format) = book_format(&file_name)?;
        let size = fs::metadata(&path)
            .ok()
            .filter(|metadata| metadata.is_file())
            .ok_or_else(|| {
                LibraryError::new(LibraryErrorCode::NotFound, "This file can't be found")
            })?
            .len();
        if size == 0 {
            return Err(LibraryError::invalid("This file is empty"));
        }
        if self
            .books()?
            .values()
            .any(|staged| staged.library_id == library_id && staged.path == path)
        {
            return Err(LibraryError::new(
                LibraryErrorCode::Conflict,
                "This book is already waiting to be added",
            ));
        }
        if !content_matches(&path, format) {
            return Err(LibraryError::invalid("This isn't a book Citadel can add"));
        }

        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut read = read_book_file(&path, &file_name, extension);
        let cover = read
            .cover
            .take()
            .and_then(cover_preview)
            .and_then(|preview| {
                let cover_path = self.cover_dir.join(format!("{id}.jpg"));
                fs::create_dir_all(&self.cover_dir).ok()?;
                fs::write(&cover_path, preview).ok()?;
                Some(cover_path)
            });
        read.book.cover_url = cover.as_deref().map(path_to_asset_url);
        let staged = Staged {
            library_id,
            path,
            file_name,
            size,
            book: read.book,
            cover,
            busy: false,
        };
        let view = staged.view(&id);
        self.books()?.insert(id, staged);
        Ok(view)
    }

    /// Claims a staged book for adding, returning its file.
    fn claim(&self, id: &str, library_id: &str) -> Result<PathBuf, LibraryError> {
        let mut books = self.books()?;
        let staged = books
            .get_mut(id)
            .filter(|staged| staged.library_id == library_id)
            .ok_or_else(not_found)?;
        if staged.busy {
            return Err(LibraryError::new(
                LibraryErrorCode::Conflict,
                "This book is already being added",
            ));
        }
        staged.busy = true;
        Ok(staged.path.clone())
    }

    fn release(&self, id: &str) {
        if let Ok(mut books) = self.books.lock() {
            if let Some(staged) = books.get_mut(id) {
                staged.busy = false;
            }
        }
    }

    fn discard(&self, id: &str) {
        let removed = self
            .books
            .lock()
            .ok()
            .and_then(|mut books| books.remove(id));
        if let Some(cover) = removed.and_then(|staged| staged.cover) {
            let _ = fs::remove_file(cover);
        }
    }
}

fn library_id(state: &CitadelState) -> Result<String, LibraryError> {
    state.active_library_id().map_err(unavailable)
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_staged_books(
    state: tauri::State<CitadelState>,
    staging: tauri::State<DesktopStaging>,
) -> Result<Vec<StagedFile>, LibraryError> {
    staging.list(&library_id(&state)?)
}

/// Reads a book file where it is, for review before it's added.
#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_stage_book(
    handle: tauri::AppHandle,
    state: tauri::State<'_, CitadelState>,
    path: String,
) -> Result<StagedFile, LibraryError> {
    use tauri::Manager;

    let library_id = library_id(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        handle
            .state::<DesktopStaging>()
            .stage(library_id, PathBuf::from(path))
    })
    .await
    .map_err(unavailable)?
}

/// Adds a staged book to the library with the metadata the person reviewed.
/// The library copies the file; the original stays where it was.
#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_add_staged_book(
    handle: tauri::AppHandle,
    state: tauri::State<'_, CitadelState>,
    account: tauri::State<'_, LocalAccount>,
    staged_id: String,
    book: CommitUpload,
) -> Result<LibraryBook, LibraryError> {
    use tauri::Manager;

    let library_id = library_id(&state)?;
    let actor = account.actor();
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let staging = handle.state::<DesktopStaging>();
        let path = staging.claim(&staged_id, &library_id)?;
        let added = book.into_book_add(path).and_then(|book| {
            state.with_library_service(|service| {
                let id = service.create_book(&actor, book)?;
                service.get_book(&id)
            })
        });
        match added {
            Ok(added) => {
                staging.discard(&staged_id);
                Ok(added)
            }
            Err(error) => {
                staging.release(&staged_id);
                Err(error)
            }
        }
    })
    .await
    .map_err(unavailable)?
}

/// Skips a staged book; its file is left untouched.
#[tauri::command]
#[specta::specta]
pub fn clb_cmd_discard_staged_book(staging: tauri::State<DesktopStaging>, staged_id: String) {
    staging.discard(&staged_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn staging() -> (tempfile::TempDir, DesktopStaging) {
        let directory = tempfile::tempdir().unwrap();
        let staging = DesktopStaging::new(directory.path().join(COVER_DIR));
        (directory, staging)
    }

    fn book_at(directory: &Path, name: &str, contents: &str) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn staged_books_belong_to_their_library() {
        let (directory, staging) = staging();
        let path = book_at(directory.path(), "Moby Dick.txt", "Call me Ishmael.");
        let staged = staging.stage("one".into(), path.clone()).unwrap();
        assert_eq!(staged.book.title, "Moby Dick");
        assert_eq!(staged.size, 16);
        assert_eq!(staging.list("one").unwrap().len(), 1);
        assert!(staging.list("two").unwrap().is_empty());
        assert!(staging.claim(&staged.id, "two").is_err());
        // Each library can stage the same file once.
        assert!(staging.stage("one".into(), path.clone()).is_err());
        assert!(staging.stage("two".into(), path).is_ok());
    }

    #[test]
    fn files_that_cant_be_books_are_refused() {
        let (directory, staging) = staging();
        let empty = book_at(directory.path(), "empty.txt", "");
        let fake = book_at(directory.path(), "fake.epub", "not a zip");
        let other = book_at(directory.path(), "notes.docx", "PK");
        for path in [empty, fake, other, directory.path().join("missing.txt")] {
            assert!(staging.stage("one".into(), path).is_err());
        }
        assert!(staging.list("one").unwrap().is_empty());
    }

    #[test]
    fn a_claimed_book_is_added_once() {
        let (directory, staging) = staging();
        let path = book_at(directory.path(), "walden.txt", "Walden");
        let staged = staging.stage("one".into(), path.clone()).unwrap();
        assert_eq!(staging.claim(&staged.id, "one").unwrap(), path);
        assert!(staging.claim(&staged.id, "one").is_err());
        staging.release(&staged.id);
        assert!(staging.claim(&staged.id, "one").is_ok());
        staging.discard(&staged.id);
        assert!(staging.list("one").unwrap().is_empty());
        assert!(path.exists(), "skipping leaves the file alone");
    }
}
