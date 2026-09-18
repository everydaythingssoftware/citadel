use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::book::{BookFile, LocalFile, LocalOrRemote, LocalOrRemoteUrl, RemoteFile};

/// Strategy for turning a book's on-disk cover/file paths into the
/// URL-bearing DTO the frontend consumes.
///
/// The URL scheme is the only thing that differs between deployments, so it is
/// injected here rather than hardcoded: the Tauri app passes an
/// [`AssetUrlBuilder`] (`asset://`), a future `citadel-server` passes an
/// [`HttpUrlBuilder`] (`https://…/api/…`). Both receive the same `libcalibre`
/// book and the absolute on-host path; each decides URL, kind, and whether to
/// retain the local path.
pub trait BookUrlBuilder {
    /// URL representation of a book's cover image. `cover_path` is the
    /// absolute path to `cover.jpg` on the machine hosting the library (only
    /// meaningful to a local builder). `cache_bust` asks the builder to make
    /// the URL change when the cover bytes change.
    fn cover_url(
        &self,
        book: &libcalibre::library::Book,
        cover_path: &Path,
        cache_bust: bool,
    ) -> LocalOrRemoteUrl;

    /// URL representation of one of a book's files. `file_path` is the absolute
    /// path on the host; `file` is the `libcalibre` record (name, format, …).
    fn file_url(
        &self,
        book: &libcalibre::library::Book,
        file: &libcalibre::BookFileInfo,
        file_path: &Path,
    ) -> BookFile;
}

/// Builds Tauri `asset://` URLs that point at files on the local filesystem.
/// This reproduces exactly the URLs the desktop app has always emitted:
/// `Local` cover/file DTOs that retain their absolute `local_path`.
pub struct AssetUrlBuilder;

impl BookUrlBuilder for AssetUrlBuilder {
    fn cover_url(
        &self,
        _book: &libcalibre::library::Book,
        cover_path: &Path,
        cache_bust: bool,
    ) -> LocalOrRemoteUrl {
        let mut url = path_to_asset_url(cover_path);

        // The cover path is stable (`…/cover.jpg`), so the webview caches it by
        // URL and keeps showing a replaced cover (e.g. after a metadata
        // lookup). Tag the URL with the cover's mtime so it re-fetches. Only
        // the single-book path does this — the list paths stay stat-free, which
        // matters at thousands of books (and the grid already cache-busts via
        // per-mtime thumbnail file names).
        if cache_bust {
            if let Some(mtime_ms) = cover_mtime_ms(cover_path) {
                url = format!("{url}?v={mtime_ms}");
            }
        }

        LocalOrRemoteUrl {
            kind: LocalOrRemote::Local,
            local_path: Some(cover_path.to_path_buf()),
            url,
        }
    }

    fn file_url(
        &self,
        _book: &libcalibre::library::Book,
        file: &libcalibre::BookFileInfo,
        file_path: &Path,
    ) -> BookFile {
        BookFile::Local(LocalFile {
            path: file_path.to_path_buf(),
            mime_type: file.format.clone(),
        })
    }
}

/// Builds `https://…/api/…` URLs for a client/server deployment, where the
/// browser fetches covers and files over HTTP rather than from the local disk.
/// Emits `Remote` DTOs (no `local_path`).
pub struct HttpUrlBuilder {
    base_url: String,
}

impl HttpUrlBuilder {
    /// `base_url` is the server origin without a trailing slash, e.g.
    /// `https://library.example.com`.
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
        }
    }
}

impl BookUrlBuilder for HttpUrlBuilder {
    fn cover_url(
        &self,
        book: &libcalibre::library::Book,
        _cover_path: &Path,
        _cache_bust: bool,
    ) -> LocalOrRemoteUrl {
        LocalOrRemoteUrl {
            kind: LocalOrRemote::Remote,
            local_path: None,
            url: format!("{}/api/books/{}/cover", self.base_url, book.id.as_i32()),
        }
    }

    fn file_url(
        &self,
        book: &libcalibre::library::Book,
        file: &libcalibre::BookFileInfo,
        _file_path: &Path,
    ) -> BookFile {
        BookFile::Remote(RemoteFile {
            url: format!(
                "{}/api/books/{}/files/{}.{}",
                self.base_url,
                book.id.as_i32(),
                file.name,
                file.format.to_lowercase()
            ),
        })
    }
}

/// Converts an absolute file path to a Tauri `asset://` URL the frontend can
/// load. Windows/Android use the `http://asset.localhost/` form instead.
pub fn path_to_asset_url(file_path: &Path) -> String {
    let os_name = std::env::consts::OS;
    let protocol = "asset";
    let path = urlencoding::encode(file_path.to_str().unwrap());
    if os_name == "windows" || os_name == "android" {
        format!("http://{}.localhost/{}", protocol, path)
    } else {
        format!("{}://localhost/{}", protocol, path)
    }
}

/// The cover file's modification time in epoch milliseconds, used as a
/// cache-busting token. `None` if the file is missing or unreadable.
fn cover_mtime_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(since.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::book::{BookFile, LibraryBook, LocalOrRemote};

    use super::*;

    fn test_book(
        has_cover: bool,
        files: Vec<libcalibre::BookFileInfo>,
    ) -> libcalibre::library::Book {
        libcalibre::library::Book {
            id: libcalibre::BookId::from(1),
            uuid: Some("test-uuid".to_string()),
            title: "Title".to_string(),
            sortable_title: None,
            authors: vec![],
            tags: vec![],
            series: None,
            series_index: None,
            description: None,
            language_codes: vec![],
            identifiers: vec![],
            has_cover,
            is_read: false,
            files,
            created_at: chrono::DateTime::UNIX_EPOCH.naive_utc(),
            updated_at: chrono::DateTime::UNIX_EPOCH.naive_utc(),
            book_dir_path: "Author/Title (1)".to_string(),
        }
    }

    fn epub_file() -> libcalibre::BookFileInfo {
        libcalibre::BookFileInfo {
            id: 1,
            format: "EPUB".to_string(),
            name: "Title - Author".to_string(),
            uncompressed_size: 0,
        }
    }

    #[test]
    fn no_cover_flag_yields_no_cover_url() {
        let book = LibraryBook::from_library_book(
            &test_book(false, vec![]),
            "/library",
            &HashMap::new(),
            &AssetUrlBuilder,
            false,
        );
        assert!(book.cover_image.is_none());
    }

    /// `has_cover` is trusted without statting cover.jpg (the per-book
    /// `PathBuf::exists` dominated list-all at 5k books). A stale flag yields a
    /// dangling URL, which the frontend's onerror fallback absorbs. With
    /// `cache_bust = true` and the cover file absent there is no mtime, so the
    /// URL carries no `?v=` token.
    #[test]
    fn asset_builder_trusts_has_cover_without_filesystem_check() {
        let book = LibraryBook::from_library_book(
            &test_book(true, vec![]),
            "/definitely/not/a/real/library",
            &HashMap::new(),
            &AssetUrlBuilder,
            true,
        );

        let cover = book.cover_image.expect("has_cover implies a cover URL");
        assert!(matches!(cover.kind, LocalOrRemote::Local));
        let path = cover.local_path.expect("local cover keeps its path");
        assert!(path.ends_with("cover.jpg"));
        assert!(!path.exists());
        assert!(cover.url.starts_with("asset://") || cover.url.contains("asset.localhost"));
        assert!(cover.url.contains("cover.jpg"));
        assert!(!cover.url.contains("?v="));
    }

    /// The acceptance criterion: the same `Book` serialized through the two
    /// builders produces local `asset://` shapes vs remote `https://…/api/…`
    /// shapes, with identical book metadata otherwise.
    #[test]
    fn asset_and_http_builders_diverge_only_on_urls() {
        let book = test_book(true, vec![epub_file()]);

        let local = LibraryBook::from_library_book(
            &book,
            "/library",
            &HashMap::new(),
            &AssetUrlBuilder,
            false,
        );
        let remote = LibraryBook::from_library_book(
            &book,
            "/library",
            &HashMap::new(),
            &HttpUrlBuilder::new("https://example.com"),
            false,
        );

        // Same underlying book metadata.
        assert_eq!(local.id, remote.id);
        assert_eq!(local.title, remote.title);

        // Cover: local asset URL with a retained path vs remote HTTP URL.
        let local_cover = local.cover_image.expect("asset cover");
        assert!(matches!(local_cover.kind, LocalOrRemote::Local));
        assert!(local_cover.local_path.is_some());
        assert!(local_cover.url.contains("cover.jpg"));

        let remote_cover = remote.cover_image.expect("http cover");
        assert!(matches!(remote_cover.kind, LocalOrRemote::Remote));
        assert!(remote_cover.local_path.is_none());
        assert_eq!(
            remote_cover.url,
            "https://example.com/api/books/1/cover".to_string()
        );

        // File list: Local(LocalFile) vs Remote(RemoteFile).
        match &local.file_list[0] {
            BookFile::Local(f) => {
                assert!(f.path.ends_with("Title - Author.epub"));
                assert_eq!(f.mime_type, "EPUB");
            }
            BookFile::Remote(_) => panic!("asset builder should emit a local file"),
        }
        match &remote.file_list[0] {
            BookFile::Remote(f) => {
                assert_eq!(
                    f.url,
                    "https://example.com/api/books/1/files/Title - Author.epub".to_string()
                );
            }
            BookFile::Local(_) => panic!("http builder should emit a remote file"),
        }
    }
}
