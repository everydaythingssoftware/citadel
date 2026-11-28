#[allow(dead_code, unused_imports)]
mod common;

use std::{collections::HashMap, path::Path};

use common::setup_with_library;
use libcalibre::{
    matching::{Candidate, MatchReason},
    BookAdd, BookId, Library, MAX_DUPLICATES,
};

fn book(title: &str, authors: &[&str]) -> BookAdd {
    BookAdd {
        title: title.into(),
        author_names: authors.iter().map(|name| name.to_string()).collect(),
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
    }
}

fn candidate(title: &str, authors: &[&str]) -> Candidate {
    Candidate {
        title: title.into(),
        author_names: authors.iter().map(|name| name.to_string()).collect(),
        isbn: None,
        languages: vec![],
    }
}

fn add(library: &mut Library, book: BookAdd) -> BookId {
    library.add_book(book).unwrap().id
}

#[test]
fn duplicates_are_found_strongest_first_in_one_read() {
    let (_directory, mut library) = setup_with_library();
    let walden = add(
        &mut library,
        BookAdd {
            identifiers: HashMap::from([("ISBN".into(), "0-306-40615-2".into())]),
            ..book("Walden", &["Henry David Thoreau"])
        },
    );
    let nana = add(&mut library, book("Nana", &["Zola, Émile"]));
    let nana_french = add(
        &mut library,
        BookAdd {
            language: Some("fr".into()),
            ..book("Nana", &["Émile Zola"])
        },
    );
    let anonymous = add(&mut library, book("Nana", &[]));
    add(&mut library, book("Nana", &["Someone Else"]));

    let found = library
        .find_duplicates(&[
            Candidate {
                isbn: Some("urn:isbn:978-0-306-40615-7".into()),
                ..candidate("Something Else Entirely", &[])
            },
            Candidate {
                languages: vec!["en".into()],
                ..candidate("NANA!", &["Emile Zola", "Émile Zola"])
            },
            candidate("Moby Dick", &["Herman Melville"]),
        ])
        .unwrap();
    let pairs: Vec<Vec<(BookId, MatchReason)>> = found
        .iter()
        .map(|matches| matches.iter().map(|m| (m.book_id, m.reason)).collect())
        .collect();
    assert_eq!(
        pairs,
        vec![
            vec![(walden, MatchReason::Isbn)],
            vec![
                (nana, MatchReason::TitleAndAuthor),
                (anonymous, MatchReason::Title)
            ],
            vec![],
        ]
    );
    assert!(!pairs[1].iter().any(|(id, _)| *id == nana_french));
    assert!(library.find_duplicates(&[]).unwrap().is_empty());
}

#[test]
fn at_most_a_few_duplicates_are_listed() {
    let (_directory, mut library) = setup_with_library();
    for _ in 0..MAX_DUPLICATES + 2 {
        add(&mut library, book("Poems", &["Anonymous"]));
    }
    let found = library
        .find_duplicates(&[candidate("Poems", &["Anonymous"])])
        .unwrap();
    assert_eq!(found[0].len(), MAX_DUPLICATES);
}

fn dirty_books(library: &Library) -> Vec<i32> {
    let conn = rusqlite::Connection::open(library.database_path()).unwrap();
    let mut statement = conn
        .prepare("SELECT book FROM metadata_dirtied ORDER BY book")
        .unwrap();
    let books = statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<i32>, _>>()
        .unwrap();
    books
}

fn clear_dirty(library: &Library) {
    rusqlite::Connection::open(library.database_path())
        .unwrap()
        .execute("DELETE FROM metadata_dirtied", [])
        .unwrap();
}

fn write(directory: &Path, name: &str, contents: &str) -> std::path::PathBuf {
    let path = directory.join(name);
    std::fs::write(&path, contents).unwrap();
    path
}

#[test]
fn files_join_an_existing_book_and_replace_a_format_it_has() {
    let (directory, mut library) = setup_with_library();
    let sources = tempfile::tempdir().unwrap();
    let first = write(sources.path(), "first.txt", "first");
    let added = library
        .add_book(BookAdd {
            file_paths: vec![first],
            ..book("Walden", &["Henry David Thoreau"])
        })
        .unwrap();
    let folder = directory.path().join(&added.book_dir_path);
    let text = folder.join("Walden - Henry David Thoreau.txt");
    assert_eq!(std::fs::read_to_string(&text).unwrap(), "first");
    clear_dirty(&library);

    let pdf = write(sources.path(), "other.pdf", "%PDF-1.4");
    let replacement = write(sources.path(), "second.TXT", "second, longer");
    let updated = library
        .add_book_files(added.id, vec![pdf, replacement])
        .unwrap();

    let mut formats: Vec<(String, i32)> = updated
        .files
        .iter()
        .map(|file| (file.format.clone(), file.uncompressed_size))
        .collect();
    formats.sort();
    assert_eq!(formats, vec![("PDF".into(), 8), ("TXT".into(), 14)]);
    assert_eq!(std::fs::read_to_string(&text).unwrap(), "second, longer");
    assert!(folder.join("Walden - Henry David Thoreau.pdf").exists());
    assert_eq!(dirty_books(&library), vec![added.id.as_i32()]);
}

#[test]
fn adding_files_checks_them_all_first() {
    let (_directory, mut library) = setup_with_library();
    let added = library.add_book(book("Walden", &[])).unwrap();
    let sources = tempfile::tempdir().unwrap();
    let real = write(sources.path(), "real.epub", "zip");
    let missing = sources.path().join("missing.pdf");
    assert!(library
        .add_book_files(added.id, vec![real.clone(), missing])
        .is_err());
    assert!(library.get_book(added.id).unwrap().files.is_empty());
    assert!(library
        .add_book_files(BookId::from(999), vec![real])
        .is_err());
}
