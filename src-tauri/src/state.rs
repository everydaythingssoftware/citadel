use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use chrono::NaiveDateTime;
use libcalibre::{BookId, BookPage, CalibreError, Library, ResolvedBookAsset};

use citadel_opds::{CatalogBookQuery, CatalogFacet, CatalogSource};

#[derive(Clone)]
pub struct CitadelState {
    inner: Arc<CitadelStateInner>,
}

struct CitadelStateInner {
    library: Mutex<Option<Library>>,
    current_library_path: Mutex<Option<String>>,
    library_switch: Mutex<()>,
    library_transitioning: AtomicBool,
}

impl CitadelState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(CitadelStateInner {
                library: Mutex::new(None),
                current_library_path: Mutex::new(None),
                library_switch: Mutex::new(()),
                library_transitioning: AtomicBool::new(false),
            }),
        }
    }

    /// Initialize or switch to a library
    pub fn init_library(&self, library_path: String) -> Result<(), String> {
        let _switch = self
            .inner
            .library_switch
            .lock()
            .expect("Library switch mutex poisoned");
        {
            let _library = self.inner.library.lock().expect("Library mutex poisoned");
            self.inner
                .library_transitioning
                .store(true, Ordering::Release);
        }
        let result = (|| {
            let db_path = libcalibre::util::get_db_path(&library_path)
                .ok_or_else(|| format!("Invalid library path: {}", library_path))?;
            let library = Library::new(db_path)
                .map_err(|error| format!("Failed to open library: {error}"))?;

            *self.inner.library.lock().expect("Library mutex poisoned") = Some(library);
            *self
                .inner
                .current_library_path
                .lock()
                .expect("Library path mutex poisoned") = Some(library_path);
            Ok(())
        })();
        {
            let _library = self.inner.library.lock().expect("Library mutex poisoned");
            self.inner
                .library_transitioning
                .store(false, Ordering::Release);
        }
        result
    }

    /// Execute a function with mutable access to the library
    pub fn with_library<F, R>(&self, f: F) -> Result<R, String>
    where
        F: FnOnce(&mut Library) -> R,
    {
        let mut lib_guard = self.inner.library.lock().expect("Library mutex poisoned");
        match lib_guard.as_mut() {
            Some(lib) => Ok(f(lib)),
            None => Err("No library initialized. Please load a library first.".to_string()),
        }
    }

    /// Get the current library path
    pub fn get_library_path(&self) -> Option<String> {
        self.inner
            .current_library_path
            .lock()
            .expect("Library path mutex poisoned")
            .clone()
    }

    /// Check if a library is currently loaded
    pub fn is_initialized(&self) -> bool {
        let library = self.inner.library.lock().expect("Library mutex poisoned");
        !self.is_library_transitioning() && library.is_some()
    }

    pub fn is_library_transitioning(&self) -> bool {
        self.inner.library_transitioning.load(Ordering::Acquire)
    }

    pub fn active_library_id(&self) -> Result<String, CalibreError> {
        let mut library = self.inner.library.lock().expect("Library mutex poisoned");
        if self.is_library_transitioning() {
            return Err(CalibreError::LibraryNotInitialized);
        }
        library
            .as_mut()
            .ok_or(CalibreError::LibraryNotInitialized)?
            .library_uuid()
    }

    /// Resolve under the library mutex and return only owned data. Opening and
    /// streaming the file must happen after this method returns.
    pub fn resolve_book_asset(
        &self,
        book_id: BookId,
        format: &str,
    ) -> Result<ResolvedBookAsset, CalibreError> {
        let mut library = self.inner.library.lock().expect("Library mutex poisoned");
        if self.is_library_transitioning() {
            return Err(CalibreError::LibraryNotInitialized);
        }
        library
            .as_mut()
            .ok_or(CalibreError::LibraryNotInitialized)?
            .resolve_book_file(book_id, format)
    }

    pub fn resolve_book_cover(&self, book_id: BookId) -> Result<ResolvedBookAsset, CalibreError> {
        let mut library = self.inner.library.lock().expect("Library mutex poisoned");
        if self.is_library_transitioning() {
            return Err(CalibreError::LibraryNotInitialized);
        }
        library
            .as_mut()
            .ok_or(CalibreError::LibraryNotInitialized)?
            .resolve_book_cover(book_id)
    }

    pub fn opds_book_page(
        &self,
        query: CatalogBookQuery,
    ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError> {
        let mut library = self.inner.library.lock().expect("Library mutex poisoned");
        if self.is_library_transitioning() {
            return Err(CalibreError::LibraryNotInitialized);
        }
        let library = library
            .as_mut()
            .ok_or(CalibreError::LibraryNotInitialized)?;
        let library_uuid = library.library_uuid()?;
        let updated_at = library.catalog_updated_at()?;
        let page = match query.into_calibre() {
            Some(query) => library.query_acquirable_books_with(query)?,
            None => BookPage {
                items: Vec::new(),
                total: 0,
            },
        };
        Ok((library_uuid, updated_at, page))
    }

    fn with_opds_library<T>(
        &self,
        operation: impl FnOnce(&mut Library) -> Result<T, CalibreError>,
    ) -> Result<T, CalibreError> {
        let mut library = self.inner.library.lock().expect("Library mutex poisoned");
        if self.is_library_transitioning() {
            return Err(CalibreError::LibraryNotInitialized);
        }
        operation(
            library
                .as_mut()
                .ok_or(CalibreError::LibraryNotInitialized)?,
        )
    }
}

impl CatalogSource for CitadelState {
    fn active_library_id(&self) -> Result<String, CalibreError> {
        CitadelState::active_library_id(self)
    }

    fn book_page(
        &self,
        query: CatalogBookQuery,
    ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError> {
        self.opds_book_page(query)
    }

    fn authors(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        self.with_opds_library(|library| {
            library.list_authors().map(|authors| {
                authors
                    .into_iter()
                    .map(|author| CatalogFacet {
                        id: author.id.as_i32(),
                        title: author.name,
                        book_count: Some(author.book_count),
                    })
                    .collect()
            })
        })
    }

    fn series(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        self.with_opds_library(|library| {
            library.list_series().map(|series| {
                series
                    .into_iter()
                    .map(|series| CatalogFacet {
                        id: series.id,
                        title: series.name,
                        book_count: Some(series.book_count),
                    })
                    .collect()
            })
        })
    }

    fn tags(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        self.with_opds_library(|library| {
            library.list_tags().map(|tags| {
                tags.into_iter()
                    .map(|tag| CatalogFacet {
                        id: tag.id,
                        title: tag.name,
                        book_count: Some(tag.book_count),
                    })
                    .collect()
            })
        })
    }

    fn book_file(&self, book_id: BookId, format: &str) -> Result<ResolvedBookAsset, CalibreError> {
        self.resolve_book_asset(book_id, format)
    }

    fn book_cover(&self, book_id: BookId) -> Result<ResolvedBookAsset, CalibreError> {
        self.resolve_book_cover(book_id)
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, path::Path, time::Duration};

    use axum::http::StatusCode;

    use super::*;

    fn extract_empty_library() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        let zip_path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/empty_7_2_calibre_lib.zip");
        let file = std::fs::File::open(zip_path).unwrap();
        zip::ZipArchive::new(file)
            .unwrap()
            .extract(directory.path())
            .unwrap();
        directory
    }

    fn add_asset(directory: &Path, byte: u8, length: usize) -> BookId {
        let root = directory.to_string_lossy().into_owned();
        let database = libcalibre::util::get_db_path(&root).unwrap();
        let mut library = libcalibre::Library::new(database).unwrap();
        let source = directory.join(format!("source-{byte}.epub"));
        std::fs::write(&source, vec![byte; length]).unwrap();
        let book = library
            .add_book(libcalibre::BookAdd {
                title: format!("Library {byte}"),
                author_names: vec!["Citadel Test".to_string()],
                tags: None,
                series: None,
                series_index: None,
                publisher: None,
                publication_date: None,
                rating: None,
                comments: None,
                identifiers: HashMap::new(),
                language: Some("eng".to_string()),
                file_paths: vec![source],
            })
            .unwrap();
        book.id
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn running_router_switches_library_at_same_url_and_is_unavailable_during_transition() {
        let first = extract_empty_library();
        let second = extract_empty_library();
        let first_book = add_asset(first.path(), b'A', 2 * 1024 * 1024);
        let second_book = add_asset(second.path(), b'B', 2 * 1024 * 1024);
        assert_eq!(first_book, second_book);
        let second_path = second.path().to_string_lossy().into_owned();
        let second_db = libcalibre::util::get_db_path(&second_path).unwrap();
        libcalibre::Library::new(second_db)
            .unwrap()
            .randomize_library_uuid()
            .unwrap();

        let state = CitadelState::new();
        state
            .init_library(first.path().to_string_lossy().into_owned())
            .unwrap();
        let first_id = state.active_library_id().unwrap();
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                citadel_opds::router(
                    Arc::new(server_state),
                    citadel_opds::OpdsBasicAuth::disabled(),
                ),
            )
            .await
            .unwrap();
        });
        let client = reqwest::Client::new();

        let first_response = client.get(format!("{base}/opds")).send().await.unwrap();
        assert_eq!(first_response.status(), StatusCode::OK);
        assert!(first_response.text().await.unwrap().contains(&first_id));

        let asset_url = format!(
            "{base}/opds/books/{}/files/EPUB/book.epub",
            first_book.as_i32()
        );
        let old_download = client.get(&asset_url).send().await.unwrap();
        assert_eq!(old_download.status(), StatusCode::OK);
        let responsive_feed = tokio::time::timeout(
            Duration::from_secs(1),
            client.get(format!("{base}/opds")).send(),
        )
        .await
        .expect("a stalled large download must not block feed requests")
        .unwrap();
        assert_eq!(responsive_feed.status(), StatusCode::OK);

        state
            .inner
            .library_transitioning
            .store(true, Ordering::Release);
        let transition_response = reqwest::get(format!("{base}/opds")).await.unwrap();
        assert_eq!(
            transition_response.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        state
            .inner
            .library_transitioning
            .store(false, Ordering::Release);

        state.init_library(second_path).unwrap();
        let second_id = state.active_library_id().unwrap();
        assert_ne!(first_id, second_id);
        let second_response = client.get(format!("{base}/opds")).send().await.unwrap();
        assert_eq!(second_response.status(), StatusCode::OK);
        assert!(second_response.text().await.unwrap().contains(&second_id));
        let new_bytes = client
            .get(&asset_url)
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert_eq!(new_bytes.len(), 2 * 1024 * 1024);
        assert!(new_bytes.iter().all(|byte| *byte == b'B'));
        let old_bytes = old_download.bytes().await.unwrap();
        assert_eq!(old_bytes.len(), 2 * 1024 * 1024);
        assert!(old_bytes.iter().all(|byte| *byte == b'A'));
        server.abort();
    }
}
