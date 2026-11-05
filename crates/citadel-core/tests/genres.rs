use citadel_core::genres::{self, GENRES_COLUMN};
use libcalibre::{BookAdd, BookQuery, CustomColumnKind, CustomColumnSpec, Library};

fn book(title: &str) -> BookAdd {
    BookAdd {
        title: title.to_string(),
        author_names: Vec::new(),
        tags: None,
        series: None,
        series_index: None,
        publisher: None,
        publication_date: None,
        rating: None,
        comments: None,
        identifiers: Default::default(),
        language: None,
        file_paths: Vec::new(),
    }
}

fn library() -> (tempfile::TempDir, Library) {
    let directory = tempfile::tempdir().unwrap();
    let library = Library::create_library_at(directory.path().to_str().unwrap()).unwrap();
    (directory, library)
}

#[test]
fn genres_are_distinct_persistent_and_queryable() {
    let (_directory, mut lib) = library();
    let first = lib
        .add_book(BookAdd {
            tags: Some(vec!["Not a Genre".to_string()]),
            ..book("First")
        })
        .unwrap();
    let second = lib.add_book(book("Second")).unwrap();

    assert!(lib
        .list_custom_column_values(GENRES_COLUMN)
        .unwrap()
        .is_empty());
    assert!(lib.custom_column(GENRES_COLUMN).unwrap().is_none());

    genres::set_book_genres(&mut lib, second.id, Vec::new()).unwrap();
    assert!(lib.custom_column(GENRES_COLUMN).unwrap().is_none());

    genres::set_book_genres(
        &mut lib,
        first.id,
        vec![" Science   Fiction ".to_string(), "Mystery".to_string()],
    )
    .unwrap();
    genres::set_book_genres(&mut lib, second.id, vec!["science fiction".to_string()]).unwrap();
    genres::add_book_genres(
        &mut lib,
        first.id,
        vec!["Fantasy".to_string(), "mystery".to_string()],
    )
    .unwrap();

    let listed = lib.list_custom_column_values(GENRES_COLUMN).unwrap();
    let summary: Vec<_> = listed
        .iter()
        .map(|genre| (genre.name.as_str(), genre.book_count))
        .collect();
    assert_eq!(
        summary,
        [("Fantasy", 1), ("Mystery", 1), ("Science Fiction", 2)]
    );

    let science_fiction = listed
        .iter()
        .find(|genre| genre.name == "Science Fiction")
        .unwrap();
    let page = lib
        .query_books(BookQuery {
            custom_value: Some(genres::filter(science_fiction.id)),
            limit: Some(1),
            offset: 1,
            ..BookQuery::default()
        })
        .unwrap();
    let titles: Vec<_> = page.items.iter().map(|book| book.title.as_str()).collect();
    assert_eq!(titles, ["Second"]);
    assert_eq!(page.total, 2);
}

#[test]
fn incompatible_genres_column_fails_actionably() {
    let (_directory, mut lib) = library();
    let book_id = lib.add_book(book("Book")).unwrap().id;
    lib.create_custom_column(CustomColumnSpec {
        label: GENRES_COLUMN.to_string(),
        name: "Genres".to_string(),
        kind: CustomColumnKind::Bool,
        is_multiple: false,
        enum_values: Vec::new(),
        display: None,
    })
    .unwrap();

    let error =
        genres::set_book_genres(&mut lib, book_id, vec!["Fantasy".to_string()]).unwrap_err();
    assert!(error.to_string().contains("multiple-value text column"));
}
