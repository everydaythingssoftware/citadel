use citadel_core::{
    contracts::{BookCandidate, BookSortOrder, BookUpdate, LibraryBookQuery, MatchReason},
    error::LibraryErrorCode,
    library::LibraryService,
    staging::{AddTo, CommitUpload},
    Actor, AssetUrlBuilder, BookFile, HttpUrlBuilder,
};
use libcalibre::{BookAdd, Library};

fn actor() -> Actor {
    Actor::User {
        id: "test-user".into(),
    }
}

fn fixture() -> (tempfile::TempDir, Library, String) {
    let directory = tempfile::tempdir().unwrap();
    let mut library = Library::create_library_at(directory.path().to_str().unwrap()).unwrap();
    let source = directory.path().join("source.txt");
    std::fs::write(&source, "contract parity").unwrap();
    let id = LibraryService::new(&mut library, &AssetUrlBuilder)
        .create_book(
            &actor(),
            BookAdd {
                title: "Contract Book".into(),
                author_names: vec!["Contract Author".into()],
                tags: Some(vec!["contract".into()]),
                series: Some("Contract Series".into()),
                series_index: Some(2.0),
                publisher: Some("Contract Press".into()),
                publication_date: None,
                rating: None,
                description: None,
                identifiers: Default::default(),
                language: Some("en".into()),
                file_paths: vec![source],
            },
            None,
        )
        .unwrap();
    (directory, library, id)
}
fn query(limit: Option<u32>) -> LibraryBookQuery {
    LibraryBookQuery {
        text: None,
        author_id: None,
        series_id: None,
        tag_id: None,
        publisher_id: None,
        hide_read: false,
        sort: BookSortOrder::TitleAsc,
        limit,
        offset: 0,
    }
}

#[test]
fn transports_share_book_content_and_preserve_count_only_and_unbounded_desktop_queries() {
    let (_directory, mut library, id) = fixture();
    let local = LibraryService::new(&mut library, &AssetUrlBuilder)
        .get_book(&id)
        .unwrap();
    let remote = LibraryService::new(&mut library, &HttpUrlBuilder::new(""))
        .get_book(&id)
        .unwrap();
    assert_eq!(local.id, remote.id);
    assert!(matches!(local.file_list[0], BookFile::Local(_)));
    assert!(
        matches!(&remote.file_list[0], BookFile::Remote(file) if file.url.starts_with("/api/books/"))
    );
    let mut local = serde_json::to_value(local).unwrap();
    let mut remote = serde_json::to_value(remote).unwrap();
    local.as_object_mut().unwrap().remove("file_list");
    remote.as_object_mut().unwrap().remove("file_list");
    assert_eq!(local, remote);
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    let count = service.query_books(query(Some(0))).unwrap();
    assert_eq!(count.total, 1);
    assert!(count.items.is_empty());
    assert_eq!(service.query_books(query(None)).unwrap().items.len(), 1);
}

#[test]
fn shared_mutation_read_state_and_genres_use_existing_library_behavior() {
    let (_directory, mut library, id) = fixture();
    let updates: BookUpdate = serde_json::from_value(serde_json::json!({
        "title": "Updated Contract", "is_read": true, "tag_list": ["updated"]
    }))
    .unwrap();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    service.update_book(&actor(), &id, updates).unwrap();
    service
        .add_genres(&actor(), &id, vec!["Speculative Fiction".into()])
        .unwrap();
    let book = service.get_book(&id).unwrap();
    assert_eq!(book.title, "Updated Contract");
    assert!(book.is_read);
    assert_eq!(book.tag_list, ["updated"]);
    assert!(service
        .list_custom_columns()
        .unwrap()
        .iter()
        .any(|column| column.label == "citadel_genres"));
    assert!(!service.get_custom_values(&id).unwrap().is_empty());
}

fn candidate(title: &str, authors: &[&str]) -> BookCandidate {
    BookCandidate {
        title: title.into(),
        author_names: authors.iter().map(|name| name.to_string()).collect(),
        identifier: None,
        language: None,
    }
}

fn commit(title: &str, add_to: AddTo) -> CommitUpload {
    serde_json::from_value::<CommitUpload>(serde_json::json!({"title": title}))
        .map(|body| CommitUpload { add_to, ..body })
        .unwrap()
}

#[test]
fn possible_duplicates_are_listed_but_never_refused() {
    let (directory, mut library, id) = fixture();
    let urls = HttpUrlBuilder::new("");
    let mut service = LibraryService::new(&mut library, &urls);
    let found = service
        .find_matches(&[
            candidate("  contract:  BOOK!", &["Author, Contract"]),
            candidate("Contract Book", &["Other Author"]),
            candidate("Contract Book", &[]),
        ])
        .unwrap();
    assert_eq!(found[0].len(), 1);
    let first = &found[0][0];
    assert_eq!(
        (first.id.as_str(), first.reason),
        (id.as_str(), MatchReason::TitleAndAuthor)
    );
    assert_eq!(first.title, "Contract Book");
    assert_eq!(first.author_names, vec!["Contract Author"]);
    assert_eq!(first.formats, vec!["TXT"]);
    assert!(first.added.is_some());
    assert!(found[1].is_empty(), "the same title by someone else");
    assert_eq!(found[2][0].reason, MatchReason::Title);

    let source = directory.path().join("again.txt");
    std::fs::write(&source, "again").unwrap();
    let again = service
        .add_staged(
            &actor(),
            commit("Contract Book", AddTo::NewBook),
            vec![source],
            None,
        )
        .unwrap();
    assert_ne!(again.id, id);
    let found = service
        .find_matches(&[candidate("Contract Book", &["Contract Author"])])
        .unwrap();
    assert_eq!(found[0].len(), 2);
}

#[test]
fn staged_files_make_one_book_or_join_an_existing_one() {
    let (directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    let file = |name: &str, contents: &str| {
        let path = directory.path().join(name);
        std::fs::write(&path, contents).unwrap();
        path
    };
    let added = service
        .add_staged(
            &actor(),
            commit("Two Formats", AddTo::NewBook),
            vec![file("two.epub", "epub"), file("two.pdf", "%PDF")],
            None,
        )
        .unwrap();
    assert_eq!(added.title, "Two Formats");
    assert_eq!(added.file_list.len(), 2);

    let existing = AddTo::ExistingBook {
        book_id: id.clone(),
    };
    let joined = service
        .add_staged(
            &actor(),
            commit("", existing.clone()),
            vec![file("more.pdf", "%PDF"), file("newer.txt", "a newer text")],
            None,
        )
        .unwrap();
    assert_eq!(joined.id, id);
    assert_eq!(joined.title, "Contract Book", "the metadata is ignored");
    let formats = service
        .find_matches(&[candidate("Contract Book", &[])])
        .unwrap();
    let mut formats = formats[0][0].formats.clone();
    formats.sort();
    assert_eq!(formats, vec!["PDF", "TXT"]);
    let BookFile::Local(text) = joined
        .file_list
        .iter()
        .find(|file| matches!(file, BookFile::Local(local) if local.path.extension().is_some_and(|e| e == "txt")))
        .unwrap()
    else {
        panic!("desktop files are local")
    };
    assert_eq!(std::fs::read_to_string(&text.path).unwrap(), "a newer text");

    let error = service
        .add_staged(
            &actor(),
            commit(
                "",
                AddTo::ExistingBook {
                    book_id: "999".into(),
                },
            ),
            vec![file("lost.txt", "lost")],
            None,
        )
        .err()
        .unwrap();
    assert_eq!(error.code, LibraryErrorCode::NotFound);
    let error = service
        .add_staged(&actor(), commit(" ", AddTo::NewBook), vec![], None)
        .err()
        .unwrap();
    assert_eq!(error.code, LibraryErrorCode::InvalidArgument);
}

#[test]
fn invalid_identifiers_and_missing_books_have_shared_error_codes() {
    let (_directory, mut library, _) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    assert_eq!(
        service.get_book("not-an-id").err().unwrap().code,
        LibraryErrorCode::InvalidArgument
    );
    assert_eq!(
        service.get_book("99999").err().unwrap().code,
        LibraryErrorCode::NotFound
    );
    let mut invalid = query(Some(50));
    invalid.author_id = Some("not-an-author".into());
    assert_eq!(
        service.query_books(invalid).err().unwrap().code,
        LibraryErrorCode::InvalidArgument
    );
}
