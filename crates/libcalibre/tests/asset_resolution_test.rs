mod common;

use std::fs;

use common::{setup_with_library, standard_test_book};
use libcalibre::{error::CalibreError, util::get_db_path, BookId, Library};
use rusqlite::{params, Connection};

fn reopen(temp: &tempfile::TempDir) -> Library {
    let path = get_db_path(temp.path().to_str().unwrap()).unwrap();
    Library::new(path).unwrap()
}

fn add_file_row(
    temp: &tempfile::TempDir,
    book_id: BookId,
    book_path: &str,
    name: &str,
    format: &str,
    bytes: &[u8],
) {
    let db = Connection::open(temp.path().join("metadata.db")).unwrap();
    db.execute(
        "INSERT INTO data (book, format, uncompressed_size, name) VALUES (?1, ?2, ?3, ?4)",
        params![book_id.as_i32(), format, bytes.len() as i32, name],
    )
    .unwrap();
    let dir = temp.path().join(book_path);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join(format!("{name}.{}", format.to_ascii_lowercase())),
        bytes,
    )
    .unwrap();
}

#[test]
fn resolves_the_matching_data_name_and_normalizes_format() {
    let (temp, mut library) = setup_with_library();
    let book = library.add_book(standard_test_book()).unwrap();
    drop(library);
    add_file_row(
        &temp,
        book.id,
        &book.book_dir_path,
        "Authoritative Calibre Name",
        "EPUB",
        b"epub",
    );

    let mut library = reopen(&temp);
    let asset = library.resolve_book_file(book.id, " .ePuB ").unwrap();
    assert_eq!(asset.download_name(), "Authoritative Calibre Name.epub");
    assert_eq!(asset.format(), "EPUB");
    assert!(asset.canonical_path().is_absolute());
    assert_eq!(fs::read(asset.canonical_path()).unwrap(), b"epub");
}

#[test]
fn distinguishes_missing_book_format_and_backing_file() {
    let (temp, mut library) = setup_with_library();
    let book = library.add_book(standard_test_book()).unwrap();
    drop(library);

    let mut library = reopen(&temp);
    assert!(matches!(
        library.resolve_book_file(BookId::from(999_999), "epub"),
        Err(CalibreError::BookNotFound(_))
    ));
    assert!(matches!(
        library.resolve_book_file(book.id, "epub"),
        Err(CalibreError::BookFileNotFound(_, ref format)) if format == "EPUB"
    ));
    drop(library);

    add_file_row(&temp, book.id, &book.book_dir_path, "Gone", "EPUB", b"gone");
    fs::remove_file(temp.path().join(&book.book_dir_path).join("Gone.epub")).unwrap();
    let mut library = reopen(&temp);
    assert!(matches!(
        library.resolve_book_file(book.id, "epub"),
        Err(CalibreError::AssetFileMissing(_))
    ));
}

#[test]
fn rejects_format_path_syntax_before_filesystem_resolution() {
    let (_temp, mut library) = setup_with_library();
    let book = library.add_book(standard_test_book()).unwrap();
    assert!(matches!(
        library.resolve_book_file(book.id, "../epub"),
        Err(CalibreError::InvalidBookFormat(_))
    ));
}

#[test]
fn distinguishes_coverless_book_from_missing_cover_file() {
    let (temp, mut library) = setup_with_library();
    let book = library.add_book(standard_test_book()).unwrap();
    assert!(matches!(
        library.resolve_book_cover(book.id),
        Err(CalibreError::BookCoverNotFound(id)) if id == book.id
    ));
    library.set_book_cover(book.id, b"cover".to_vec()).unwrap();
    let cover_path = library.resolve_book_cover(book.id).unwrap();
    assert_eq!(cover_path.download_name(), "cover.jpg");
    assert_eq!(cover_path.format(), "JPG");
    fs::remove_file(cover_path.canonical_path()).unwrap();
    drop(library);
    let mut library = reopen(&temp);
    assert!(matches!(
        library.resolve_book_cover(book.id),
        Err(CalibreError::AssetFileMissing(_))
    ));
}

#[test]
fn rejects_a_malformed_database_book_path_that_escapes_the_library() {
    let (temp, mut library) = setup_with_library();
    let book = library.add_book(standard_test_book()).unwrap();
    drop(library);

    let outside_dir = temp
        .path()
        .parent()
        .unwrap()
        .join(format!("citadel-escaped-book-{}", std::process::id()));
    fs::create_dir_all(&outside_dir).unwrap();
    fs::write(outside_dir.join("Outside.epub"), b"outside").unwrap();
    let escaped_book_path = format!("../{}", outside_dir.file_name().unwrap().to_string_lossy());
    let db = Connection::open(temp.path().join("metadata.db")).unwrap();
    db.execute_batch("DROP TRIGGER IF EXISTS books_update_trg")
        .unwrap();
    db.execute(
        "UPDATE books SET path = ?1 WHERE id = ?2",
        params![escaped_book_path, book.id.as_i32()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO data (book, format, uncompressed_size, name) VALUES (?1, 'EPUB', 7, 'Outside')",
        [book.id.as_i32()],
    )
    .unwrap();
    drop(db);

    let mut library = reopen(&temp);
    assert!(matches!(
        library.resolve_book_file(book.id, "epub"),
        Err(CalibreError::AssetOutsideLibrary)
    ));
    fs::remove_dir_all(outside_dir).unwrap();
}

#[cfg(unix)]
#[test]
fn rejects_a_symlink_that_escapes_the_library() {
    use std::os::unix::fs::symlink;

    let (temp, mut library) = setup_with_library();
    let book = library.add_book(standard_test_book()).unwrap();
    drop(library);
    add_file_row(
        &temp,
        book.id,
        &book.book_dir_path,
        "Escaped",
        "EPUB",
        b"placeholder",
    );
    let asset_path = temp.path().join(&book.book_dir_path).join("Escaped.epub");
    fs::remove_file(&asset_path).unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    symlink(outside.path(), asset_path).unwrap();

    let mut library = reopen(&temp);
    assert!(matches!(
        library.resolve_book_file(book.id, "epub"),
        Err(CalibreError::AssetOutsideLibrary)
    ));
}
