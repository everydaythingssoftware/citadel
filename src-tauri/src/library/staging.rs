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
    contracts::BookMatch,
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
    /// A PDF's rendered first page at full size, to add with the book.
    rendered_cover: Option<PathBuf>,
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
    /// Books the library may already hold, strongest match first. Empty
    /// when there are none or the library couldn't be read.
    matches: Vec<BookMatch>,
}

impl Staged {
    fn view(&self, id: &str) -> StagedFile {
        StagedFile {
            id: id.to_string(),
            file_name: self.file_name.clone(),
            size: self.size,
            book: self.book.clone(),
            matches: Vec::new(),
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
fn content_matches(path: &Path, format: libcalibre::mime_type::MimeType) -> bool {
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
        let mut read = read_book_file(&path, &file_name, extension, crate::libs::pdf_cover::render);
        let rendered_cover = read
            .rendered_cover
            .then_some(read.cover.as_deref())
            .flatten()
            .and_then(|cover| {
                let cover_path = self.cover_dir.join(format!("{id}.page.jpg"));
                fs::create_dir_all(&self.cover_dir).ok()?;
                fs::write(&cover_path, cover).ok()?;
                Some(cover_path)
            });
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
            rendered_cover,
            busy: false,
        };
        let view = staged.view(&id);
        self.books()?.insert(id, staged);
        Ok(view)
    }

    /// Claims staged books for adding, all or none, returning their files
    /// in order and any cover rendered from the first.
    fn claim(
        &self,
        ids: &[String],
        library_id: &str,
    ) -> Result<(Vec<PathBuf>, Option<Vec<u8>>), LibraryError> {
        let mut books = self.books()?;
        let mut paths = Vec::with_capacity(ids.len());
        for id in ids {
            let staged = books
                .get(id)
                .filter(|staged| staged.library_id == library_id)
                .ok_or_else(not_found)?;
            if staged.busy {
                return Err(LibraryError::new(
                    LibraryErrorCode::Conflict,
                    "This book is already being added",
                ));
            }
            paths.push(staged.path.clone());
        }
        for id in ids {
            if let Some(staged) = books.get_mut(id) {
                staged.busy = true;
            }
        }
        let cover = ids
            .first()
            .and_then(|id| books.get(id))
            .and_then(|staged| staged.rendered_cover.as_ref())
            .and_then(|path| fs::read(path).ok());
        Ok((paths, cover))
    }

    fn release(&self, ids: &[String]) {
        if let Ok(mut books) = self.books.lock() {
            for id in ids {
                if let Some(staged) = books.get_mut(id) {
                    staged.busy = false;
                }
            }
        }
    }

    fn discard(&self, id: &str) {
        let removed = self
            .books
            .lock()
            .ok()
            .and_then(|mut books| books.remove(id));
        for cover in removed
            .into_iter()
            .flat_map(|staged| [staged.cover, staged.rendered_cover])
            .flatten()
        {
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
    let mut files = staging.list(&library_id(&state)?)?;
    list_matches(&state, &mut files);
    Ok(files)
}

/// Lists the books the library may already hold for each file, with one
/// library read for all; a library that can't be read lists none.
fn list_matches(state: &CitadelState, files: &mut [StagedFile]) {
    if files.is_empty() {
        return;
    }
    let candidates: Vec<_> = files.iter().map(|file| file.book.candidate()).collect();
    let found = state
        .with_library_service(|service| service.find_matches(&candidates))
        .unwrap_or_default();
    for (file, matches) in files.iter_mut().zip(found) {
        file.matches = matches;
    }
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
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut staged = handle
            .state::<DesktopStaging>()
            .stage(library_id, PathBuf::from(path))?;
        list_matches(&state, std::slice::from_mut(&mut staged));
        Ok(staged)
    })
    .await
    .map_err(unavailable)?
}

/// Adds a staged book, and the staged books named in `book.also`, to the
/// library: as one new book with the metadata the person reviewed, or as
/// further formats of an existing book. All are added or none. The library
/// copies the files; the originals stay where they were.
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
        let mut ids = vec![staged_id];
        for also in &book.also {
            if !ids.contains(also) {
                ids.push(also.clone());
            }
        }
        let (paths, cover) = staging.claim(&ids, &library_id)?;
        match state.with_library_service(|service| service.add_staged(&actor, book, paths, cover)) {
            Ok(added) => {
                for id in &ids {
                    staging.discard(id);
                }
                Ok(added)
            }
            Err(error) => {
                staging.release(&ids);
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
        assert!(staging
            .claim(std::slice::from_ref(&staged.id), "two")
            .is_err());
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
        let ids = [staged.id.clone()];
        assert_eq!(
            staging.claim(&ids, "one").unwrap(),
            (vec![path.clone()], None)
        );
        assert!(staging.claim(&ids, "one").is_err());
        staging.release(&ids);
        assert!(staging.claim(&ids, "one").is_ok());
        staging.discard(&staged.id);
        assert!(staging.list("one").unwrap().is_empty());
        assert!(path.exists(), "skipping leaves the file alone");
    }

    #[test]
    fn several_books_are_claimed_together_or_not_at_all() {
        let (directory, staging) = staging();
        let one = staging
            .stage("one".into(), book_at(directory.path(), "a.txt", "A"))
            .unwrap();
        let two = staging
            .stage("one".into(), book_at(directory.path(), "b.txt", "B"))
            .unwrap();
        let both = [one.id.clone(), two.id.clone()];
        staging.claim(std::slice::from_ref(&two.id), "one").unwrap();
        assert!(staging.claim(&both, "one").is_err());
        assert!(
            staging.claim(std::slice::from_ref(&one.id), "one").is_ok(),
            "a failed claim claims nothing"
        );
        staging.release(&both);
        assert_eq!(staging.claim(&both, "one").unwrap().0.len(), 2);
        assert!(staging
            .claim(&[one.id.clone(), "missing".into()], "two")
            .is_err());
    }

    #[test]
    fn books_the_library_may_hold_are_listed() {
        let library = tempfile::tempdir().unwrap();
        libcalibre::Library::create_library_at(library.path().to_str().unwrap()).unwrap();
        let state = CitadelState::new();
        state
            .init_library(library.path().to_string_lossy().into_owned())
            .unwrap();
        let id = state
            .with_library_service(|service| {
                service.create_book(
                    &citadel_core::Actor::User { id: "test".into() },
                    libcalibre::BookAdd {
                        title: "Moby Dick".into(),
                        author_names: vec![],
                        tags: None,
                        series: None,
                        series_index: None,
                        publisher: None,
                        publication_date: None,
                        rating: None,
                        description: None,
                        identifiers: HashMap::new(),
                        language: None,
                        file_paths: vec![],
                    },
                    None,
                )
            })
            .unwrap();
        let (directory, staging) = staging();
        let mut files = ["moby dick.txt", "Walden.txt"]
            .map(|name| {
                let path = book_at(directory.path(), name, "Call me Ishmael.");
                staging.stage("one".into(), path).unwrap()
            })
            .to_vec();
        list_matches(&state, &mut files);
        assert_eq!(files[0].matches.len(), 1);
        assert_eq!(files[0].matches[0].id, id);
        assert_eq!(
            files[0].matches[0].reason,
            citadel_core::contracts::MatchReason::Title
        );
        assert!(files[1].matches.is_empty());

        let mut files = staging.list("one").unwrap();
        list_matches(&CitadelState::new(), &mut files);
        assert!(files.iter().all(|file| file.matches.is_empty()));
    }
}
