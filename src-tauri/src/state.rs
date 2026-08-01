use std::sync::Mutex;

use chrono::NaiveDateTime;
use libcalibre::{BookId, BookPage, CalibreError, Library, ResolvedBookAsset};

use citadel_opds::CatalogSource;

pub struct CitadelState {
    library: Mutex<Option<Library>>,
    current_library_path: Mutex<Option<String>>,
}

impl CitadelState {
    pub fn new() -> Self {
        Self {
            library: Mutex::new(None),
            current_library_path: Mutex::new(None),
        }
    }

    /// Initialize or switch to a library
    pub fn init_library(&self, library_path: String) -> Result<(), String> {
        let db_path = libcalibre::util::get_db_path(&library_path)
            .ok_or_else(|| format!("Invalid library path: {}", library_path))?;

        let lib = Library::new(db_path).map_err(|e| format!("Failed to open library: {}", e))?;

        *self.library.lock().expect("Library mutex poisoned") = Some(lib);
        *self
            .current_library_path
            .lock()
            .expect("Library path mutex poisoned") = Some(library_path);

        Ok(())
    }

    /// Execute a function with mutable access to the library
    pub fn with_library<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&mut Library) -> R,
    {
        let mut lib_guard = self.library.lock().expect("Library mutex poisoned");
        match lib_guard.as_mut() {
            Some(lib) => Ok(f(lib)),
            None => Err("No library initialized. Please load a library first.".to_string()),
        }
    }

    /// Get the current library path
    pub fn get_library_path(&self) -> Option<String> {
        self.current_library_path
            .lock()
            .expect("Library path mutex poisoned")
            .clone()
    }

    /// Check if a library is currently loaded
    pub fn is_initialized(&self) -> bool {
        self.library
            .lock()
            .expect("Library mutex poisoned")
            .is_some()
    }

    /// Resolve under the library mutex and return only owned data. Opening and
    /// streaming the file must happen after this method returns.
    pub fn resolve_book_asset(
        &self,
        book_id: BookId,
        format: &str,
    ) -> Result<ResolvedBookAsset, CalibreError> {
        let mut library = self.library.lock().expect("Library mutex poisoned");
        library
            .as_mut()
            .ok_or(CalibreError::LibraryNotInitialized)?
            .resolve_book_file(book_id, format)
    }

    pub fn resolve_book_cover(&self, book_id: BookId) -> Result<ResolvedBookAsset, CalibreError> {
        let mut library = self.library.lock().expect("Library mutex poisoned");
        library
            .as_mut()
            .ok_or(CalibreError::LibraryNotInitialized)?
            .resolve_book_cover(book_id)
    }

    pub fn opds_book_page(
        &self,
        limit: i64,
        offset: i64,
    ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError> {
        let mut library = self.library.lock().expect("Library mutex poisoned");
        let library = library
            .as_mut()
            .ok_or(CalibreError::LibraryNotInitialized)?;
        let library_uuid = library.library_uuid()?;
        let updated_at = library.catalog_updated_at()?;
        let page = library.query_acquirable_books(limit, offset)?;
        Ok((library_uuid, updated_at, page))
    }
}

impl CatalogSource for CitadelState {
    fn active_library_id(&self) -> Result<String, CalibreError> {
        CitadelState::active_library_id(self)
    }

    fn book_page(
        &self,
        limit: i64,
        offset: i64,
    ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError> {
        self.opds_book_page(limit, offset)
    }

    fn book_file(&self, book_id: BookId, format: &str) -> Result<ResolvedBookAsset, CalibreError> {
        self.resolve_book_asset(book_id, format)
    }

    fn book_cover(&self, book_id: BookId) -> Result<ResolvedBookAsset, CalibreError> {
        self.resolve_book_cover(book_id)
    }
}
