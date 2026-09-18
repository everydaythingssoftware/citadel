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
