use std::collections::HashMap;

use citadel_core::{AssetUrlBuilder, LibraryBook};
use libcalibre::{AuthorId, Library};

/// Hydrate one `libcalibre` book into the frontend DTO using the desktop
/// app's `asset://` URL scheme. `cache_bust_cover` forwards to the builder:
/// the single-book path sets it so a freshly applied cover re-fetches; the
/// list paths leave it off to stay stat-free at thousands of books.
fn to_library_book(
    library_root: &str,
    book: &libcalibre::library::Book,
    author_book_counts: &HashMap<AuthorId, i64>,
    cache_bust_cover: bool,
) -> LibraryBook {
    LibraryBook::from_library_book(
        book,
        library_root,
        author_book_counts,
        &AssetUrlBuilder,
        cache_bust_cover,
    )
}

/// One book, hydrated exactly like a `query_page` item (authors, tags,
/// series, identifiers, files, read state, cover URL, author book counts).
pub fn get_one(
    library_root: String,
    lib: &mut Library,
    book_id: libcalibre::BookId,
) -> Result<LibraryBook, libcalibre::CalibreError> {
    let book = lib.get_book(book_id)?;
    let author_book_counts = lib.author_book_counts()?;
    // Single book (e.g. the Edit page): cache-bust the cover so a freshly
    // applied cover is shown instead of the webview's cached copy.
    Ok(to_library_book(
        &library_root,
        &book,
        &author_book_counts,
        true,
    ))
}

/// Applies `update` and returns the book hydrated exactly like [`get_one`],
/// so callers can patch it into their state without a follow-up read.
pub fn update_one(
    library_root: String,
    lib: &mut Library,
    book_id: libcalibre::BookId,
    update: libcalibre::BookUpdate,
) -> Result<LibraryBook, libcalibre::CalibreError> {
    let book = lib.update_book(book_id, update)?;
    let author_book_counts = lib.author_book_counts()?;
    Ok(to_library_book(
        &library_root,
        &book,
        &author_book_counts,
        true,
    ))
}

pub fn search(
    library_root: String,
    lib: &mut Library,
    query: &str,
) -> Result<Vec<LibraryBook>, libcalibre::CalibreError> {
    let results = lib.search_books(query)?;
    let author_book_counts = lib.author_book_counts()?;

    Ok(results
        .iter()
        .map(|book| to_library_book(&library_root, book, &author_book_counts, false))
        .collect())
}

pub fn query_page(
    library_root: String,
    lib: &mut Library,
    query: libcalibre::BookQuery,
) -> Result<(Vec<LibraryBook>, u64), libcalibre::CalibreError> {
    let page = lib.query_books(query)?;
    let author_book_counts = lib.author_book_counts()?;

    Ok((
        page.items
            .iter()
            .map(|book| to_library_book(&library_root, book, &author_book_counts, false))
            .collect(),
        page.total,
    ))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn open_empty_library(target: &Path) -> (String, Library) {
        let zip_path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/empty_7_2_calibre_lib.zip");
        let file = std::fs::File::open(zip_path).unwrap();
        zip::ZipArchive::new(file).unwrap().extract(target).unwrap();
        let library_root = target.to_string_lossy().into_owned();
        let db_path = libcalibre::util::get_db_path(&library_root).unwrap();
        (library_root, Library::new(db_path).unwrap())
    }

    #[test]
    fn update_one_returns_the_hydrated_updated_book() {
        let tmp = tempfile::tempdir().unwrap();
        let (library_root, mut lib) = open_empty_library(tmp.path());
        let added = lib
            .add_book(libcalibre::BookAdd {
                title: "Old Title".to_string(),
                author_names: vec!["Ann Author".to_string()],
                tags: None,
                series: None,
                series_index: None,
                publisher: None,
                publication_date: None,
                rating: None,
                comments: None,
                identifiers: HashMap::new(),
                language: None,
                file_paths: Vec::new(),
            })
            .unwrap();

        let updated = update_one(
            library_root.clone(),
            &mut lib,
            added.id,
            libcalibre::BookUpdate {
                title: Some("New Title".to_string()),
                author_names: None,
                author_ids: None,
                description: None,
                is_read: Some(true),
                publication_date: None,
                tags: Some(vec!["fiction".to_string()]),
                series: None,
                series_index: None,
                language_codes: None,
                publisher: None,
                rating: None,
                comments: None,
                identifiers: None,
            },
        )
        .unwrap();

        assert_eq!(updated.id, added.id.as_i32().to_string());
        assert_eq!(updated.title, "New Title");
        assert!(updated.is_read);
        assert_eq!(updated.tag_list, vec!["fiction".to_string()]);
        assert_eq!(updated.author_list.len(), 1);

        let refetched = get_one(library_root, &mut lib, added.id).unwrap();
        assert_eq!(refetched.title, updated.title);
        assert_eq!(refetched.is_read, updated.is_read);
    }
}
