use citadel_core::{
    contracts::{BookSortOrder, BookUpdate, LibraryBookQuery},
    error::LibraryErrorCode,
    library::LibraryService,
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
    std::fs::copy(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../libcalibre/tests/fixtures/empty_library/metadata.db"
        ),
        directory.path().join("metadata.db"),
    )
    .unwrap();
    let path = libcalibre::util::get_db_path(directory.path().to_str().unwrap()).unwrap();
    let mut library = Library::new(path).unwrap();
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
                comments: None,
                identifiers: Default::default(),
                language: Some("en".into()),
                file_paths: vec![source],
            },
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
