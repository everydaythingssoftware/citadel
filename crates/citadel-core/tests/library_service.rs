use citadel_core::{
    contracts::{BookEdit, BookSortOrder, BookUpdate, EditBooksOutcome, LibraryBookQuery},
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

fn edit(id: &str) -> BookEdit {
    BookEdit {
        book_id: id.into(),
        series: None,
        add_tags: vec![],
        remove_tags: vec![],
        add_languages: vec![],
        remove_languages: vec![],
        publisher: None,
    }
}

fn names(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

/// Adds a second book to the library of `fixture`, with the tags and no
/// series, language or publisher.
fn second_book(
    service: &mut LibraryService<'_>,
    directory: &tempfile::TempDir,
    tags: &[&str],
) -> String {
    let source = directory.path().join("second.txt");
    std::fs::write(&source, "second").unwrap();
    service
        .create_book(
            &actor(),
            BookAdd {
                title: "Second Book".into(),
                author_names: vec!["Contract Author".into()],
                tags: Some(names(tags)),
                series: None,
                series_index: None,
                publisher: None,
                publication_date: None,
                rating: None,
                description: None,
                identifiers: Default::default(),
                language: None,
                file_paths: vec![source],
            },
        )
        .unwrap()
}

/// The fields that an edit of several books can change.
fn edited_fields(
    service: &mut LibraryService<'_>,
    id: &str,
) -> (
    Vec<String>,
    Vec<String>,
    Option<String>,
    Option<f32>,
    Option<String>,
) {
    let book = service.get_book(id).unwrap();
    (
        book.tag_list,
        book.language_list,
        book.series,
        book.series_index,
        book.publisher,
    )
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

#[test]
fn library_book_carries_the_publisher() {
    let (_directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    assert_eq!(
        service.get_book(&id).unwrap().publisher.as_deref(),
        Some("Contract Press")
    );
}

#[test]
fn edit_books_adds_and_removes_tags_ignoring_case_and_blanks() {
    let (_directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    service
        .edit_books(
            &actor(),
            vec![BookEdit {
                add_tags: names(&["CONTRACT", "new", "  "]),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert_eq!(service.get_book(&id).unwrap().tag_list, ["contract", "new"]);
    service
        .edit_books(
            &actor(),
            vec![BookEdit {
                remove_tags: names(&[" Contract "]),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert_eq!(service.get_book(&id).unwrap().tag_list, ["new"]);
}

#[test]
fn edit_books_keeps_tags_that_the_patch_does_not_name() {
    let (_directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    service
        .edit_books(
            &actor(),
            vec![BookEdit {
                add_tags: names(&["other"]),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert_eq!(
        service.get_book(&id).unwrap().tag_list,
        ["contract", "other"]
    );
}

#[test]
fn edit_books_adds_no_tag_that_the_book_has_with_a_trailing_space() {
    let (_directory, mut library, id) = fixture();
    let book_id = libcalibre::BookId::from(id.parse::<i32>().unwrap());
    library
        .update_book(
            book_id,
            libcalibre::BookUpdate {
                tags: Some(names(&["Sci-Fi "])),
                ..Default::default()
            },
        )
        .unwrap();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    let outcome = service
        .edit_books(
            &actor(),
            vec![BookEdit {
                add_tags: names(&["Sci-Fi"]),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert!(outcome.undo.is_empty(), "{:?}", outcome.undo);
    assert_eq!(service.get_book(&id).unwrap().tag_list, ["Sci-Fi "]);
}

#[test]
fn edit_books_links_an_existing_tag_with_different_case() {
    let (directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    second_book(&mut service, &directory, &["Epic"]);
    service
        .edit_books(
            &actor(),
            vec![BookEdit {
                add_tags: names(&["epic"]),
                ..edit(&id)
            }],
        )
        .unwrap();
    let epic: Vec<_> = service
        .list_tags()
        .unwrap()
        .into_iter()
        .filter(|tag| tag.name.eq_ignore_ascii_case("epic"))
        .collect();
    assert_eq!(epic.len(), 1);
    assert_eq!(epic[0].name, "Epic");
    assert!(service
        .get_book(&id)
        .unwrap()
        .tag_list
        .contains(&"Epic".to_string()));
}

#[test]
fn edit_books_compares_language_codes_in_canonical_form() {
    let (_directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    service
        .edit_books(
            &actor(),
            vec![BookEdit {
                add_languages: names(&["fr"]),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert_eq!(service.get_book(&id).unwrap().language_list, ["eng", "fra"]);
    service
        .edit_books(
            &actor(),
            vec![BookEdit {
                remove_languages: names(&["en"]),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert_eq!(service.get_book(&id).unwrap().language_list, ["fra"]);
}

#[test]
fn edit_books_sets_clears_and_keeps_series_and_publisher() {
    let (_directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    service
        .edit_books(
            &actor(),
            vec![BookEdit {
                series: Some("New".into()),
                ..edit(&id)
            }],
        )
        .unwrap();
    let book = service.get_book(&id).unwrap();
    assert_eq!(book.series.as_deref(), Some("New"));
    assert_eq!(book.publisher.as_deref(), Some("Contract Press"));
    service
        .edit_books(
            &actor(),
            vec![BookEdit {
                series: Some("".into()),
                publisher: Some(" ".into()),
                ..edit(&id)
            }],
        )
        .unwrap();
    let book = service.get_book(&id).unwrap();
    assert_eq!(book.series, None);
    assert_eq!(book.publisher, None);
}

#[test]
fn edit_books_leaves_an_unchanged_book_untouched() {
    let (_directory, mut library, id) = fixture();
    let book_id = libcalibre::BookId::from(id.parse::<i32>().unwrap());
    let before = library.get_book(book_id).unwrap().updated_at;
    LibraryService::new(&mut library, &AssetUrlBuilder)
        .edit_books(
            &actor(),
            vec![BookEdit {
                add_tags: names(&["contract"]),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert_eq!(library.get_book(book_id).unwrap().updated_at, before);
}

#[test]
fn edit_books_refuses_bad_duplicate_and_unknown_ids_before_any_write() {
    let (_directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    let with_tag = || BookEdit {
        add_tags: names(&["x"]),
        ..edit(&id)
    };
    let code = |result: Result<EditBooksOutcome, citadel_core::error::LibraryError>| {
        result.unwrap_err().code
    };
    assert_eq!(
        code(service.edit_books(&actor(), vec![with_tag(), edit("not-an-id")])),
        LibraryErrorCode::InvalidArgument
    );
    assert_eq!(service.get_book(&id).unwrap().tag_list, ["contract"]);
    assert_eq!(
        code(service.edit_books(&actor(), vec![with_tag(), with_tag()])),
        LibraryErrorCode::InvalidArgument
    );
    assert_eq!(service.get_book(&id).unwrap().tag_list, ["contract"]);
    assert_eq!(
        code(service.edit_books(&actor(), vec![with_tag(), edit("99999")])),
        LibraryErrorCode::NotFound
    );
    assert_eq!(service.get_book(&id).unwrap().tag_list, ["contract"]);
}

#[test]
fn edit_books_accepts_an_empty_list() {
    let (_directory, mut library, _id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    assert!(service
        .edit_books(&actor(), vec![])
        .unwrap()
        .undo
        .is_empty());
}

#[test]
fn edit_books_returns_the_undo_edits_of_a_tag_add_and_a_tag_remove() {
    let (_directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    let outcome = service
        .edit_books(
            &actor(),
            vec![BookEdit {
                add_tags: names(&["New"]),
                remove_tags: names(&["CONTRACT"]),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert_eq!(
        outcome.undo,
        [BookEdit {
            add_tags: names(&["contract"]),
            remove_tags: names(&["New"]),
            ..edit(&id)
        }]
    );
}

#[test]
fn edit_books_undo_keeps_the_order_and_the_primary_language() {
    let (_directory, mut library, id) = fixture();
    let book_id = libcalibre::BookId::from(id.parse::<i32>().unwrap());
    library
        .update_book(
            book_id,
            libcalibre::BookUpdate {
                language_codes: Some(names(&["fra", "eng"])),
                ..Default::default()
            },
        )
        .unwrap();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    let outcome = service
        .edit_books(
            &actor(),
            vec![BookEdit {
                remove_languages: names(&["fra"]),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert_eq!(service.get_book(&id).unwrap().language_list, ["eng"]);
    assert_eq!(
        outcome.undo,
        [BookEdit {
            add_languages: names(&["fra", "eng"]),
            remove_languages: names(&["eng"]),
            ..edit(&id)
        }]
    );
    service.edit_books(&actor(), outcome.undo).unwrap();
    assert_eq!(service.get_book(&id).unwrap().language_list, ["fra", "eng"]);
}

#[test]
fn edit_books_gives_no_entry_for_a_typed_code_that_the_book_has() {
    let (_directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    let outcome = service
        .edit_books(
            &actor(),
            vec![BookEdit {
                add_languages: names(&["en"]),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert!(outcome.undo.is_empty());
    assert_eq!(service.get_book(&id).unwrap().language_list, ["eng"]);
}

#[test]
fn edit_books_drops_blank_and_repeated_codes_and_skips_an_absent_code() {
    let (_directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    service
        .edit_books(
            &actor(),
            vec![BookEdit {
                add_languages: names(&["  ", "fr", "FR"]),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert_eq!(service.get_book(&id).unwrap().language_list, ["eng", "fra"]);
    let outcome = service
        .edit_books(
            &actor(),
            vec![BookEdit {
                remove_languages: names(&["deu"]),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert!(outcome.undo.is_empty());
    assert_eq!(service.get_book(&id).unwrap().language_list, ["eng", "fra"]);
}

#[test]
fn edit_books_keeps_the_tag_of_a_book_that_had_it_before_the_edit() {
    let (directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    let other = second_book(&mut service, &directory, &["Epic"]);
    let outcome = service
        .edit_books(
            &actor(),
            vec![
                BookEdit {
                    add_tags: names(&["Epic"]),
                    ..edit(&id)
                },
                BookEdit {
                    add_tags: names(&["Epic"]),
                    ..edit(&other)
                },
            ],
        )
        .unwrap();
    assert_eq!(
        outcome.undo,
        [BookEdit {
            remove_tags: names(&["Epic"]),
            ..edit(&id)
        }]
    );
    service.edit_books(&actor(), outcome.undo).unwrap();
    assert_eq!(service.get_book(&id).unwrap().tag_list, ["contract"]);
    assert_eq!(service.get_book(&other).unwrap().tag_list, ["Epic"]);
}

#[test]
fn edit_books_returns_the_old_series_and_publisher() {
    let (_directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    let old = || BookEdit {
        series: Some("Contract Series".into()),
        publisher: Some("Contract Press".into()),
        ..edit(&id)
    };
    let set = service
        .edit_books(
            &actor(),
            vec![BookEdit {
                series: Some("New".into()),
                publisher: Some("Other".into()),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert_eq!(set.undo, [old()]);
    service.edit_books(&actor(), set.undo).unwrap();
    let cleared = service
        .edit_books(
            &actor(),
            vec![BookEdit {
                series: Some("".into()),
                publisher: Some(" ".into()),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert_eq!(cleared.undo, [old()]);
    let from_none = service
        .edit_books(
            &actor(),
            vec![BookEdit {
                series: Some("New".into()),
                publisher: Some("Other".into()),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert_eq!(
        from_none.undo,
        [BookEdit {
            series: Some("".into()),
            publisher: Some("".into()),
            ..edit(&id)
        }]
    );
}

#[test]
fn edit_books_writes_nothing_for_the_series_that_the_book_has() {
    let (_directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    let outcome = service
        .edit_books(
            &actor(),
            vec![BookEdit {
                series: Some(" Contract Series ".into()),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert!(outcome.undo.is_empty());
}

#[test]
fn edit_books_treats_a_series_or_publisher_that_differs_only_in_case_as_no_change() {
    let (_directory, mut library, id) = fixture();
    let book_id = libcalibre::BookId::from(id.parse::<i32>().unwrap());
    library
        .update_book(
            book_id,
            libcalibre::BookUpdate {
                series: Some("Dune".into()),
                publisher: Some("Ace Books".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let before = library.get_book(book_id).unwrap().updated_at;
    for case_only in [
        BookEdit {
            series: Some("dune".into()),
            ..edit(&id)
        },
        BookEdit {
            publisher: Some("ace books".into()),
            ..edit(&id)
        },
    ] {
        let outcome = LibraryService::new(&mut library, &AssetUrlBuilder)
            .edit_books(&actor(), vec![case_only])
            .unwrap();
        assert!(outcome.undo.is_empty(), "{:?}", outcome.undo);
        assert_eq!(library.get_book(book_id).unwrap().updated_at, before);
    }
}

#[test]
fn edit_books_returns_an_entry_only_for_the_book_that_changes() {
    let (directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    let other = second_book(&mut service, &directory, &["other"]);
    let outcome = service
        .edit_books(
            &actor(),
            vec![
                BookEdit {
                    add_tags: names(&["contract"]),
                    ..edit(&id)
                },
                BookEdit {
                    add_tags: names(&["new"]),
                    ..edit(&other)
                },
            ],
        )
        .unwrap();
    assert_eq!(
        outcome.undo,
        [BookEdit {
            remove_tags: names(&["new"]),
            ..edit(&other)
        }]
    );
    assert_eq!(service.get_book(&id).unwrap().tag_list, ["contract"]);
    assert_eq!(service.get_book(&other).unwrap().tag_list, ["new", "other"]);
}

#[test]
fn edit_books_undo_restores_each_book_exactly() {
    let (directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    let other = second_book(&mut service, &directory, &["Epic", "other"]);
    let before = [
        edited_fields(&mut service, &id),
        edited_fields(&mut service, &other),
    ];
    let forward = |book_id: &str| BookEdit {
        series: Some("Saga".into()),
        add_tags: names(&["Epic", "new"]),
        remove_tags: names(&["contract", "other"]),
        add_languages: names(&["fr"]),
        remove_languages: names(&["en"]),
        publisher: Some("".into()),
        ..edit(book_id)
    };
    let outcome = service
        .edit_books(&actor(), vec![forward(&id), forward(&other)])
        .unwrap();
    assert_eq!(outcome.undo.len(), 2);
    service.edit_books(&actor(), outcome.undo).unwrap();
    let after = [
        edited_fields(&mut service, &id),
        edited_fields(&mut service, &other),
    ];
    assert_eq!(after, before);
}

#[test]
fn edit_books_undo_restores_a_cleared_series_and_its_index() {
    let (_directory, mut library, id) = fixture();
    let mut service = LibraryService::new(&mut library, &AssetUrlBuilder);
    let before = edited_fields(&mut service, &id);
    assert_eq!(before.3, Some(2.0));
    let outcome = service
        .edit_books(
            &actor(),
            vec![BookEdit {
                series: Some("".into()),
                ..edit(&id)
            }],
        )
        .unwrap();
    assert_eq!(service.get_book(&id).unwrap().series, None);
    service.edit_books(&actor(), outcome.undo).unwrap();
    assert_eq!(edited_fields(&mut service, &id), before);
}

#[test]
fn book_edit_refuses_an_unknown_field() {
    let error = serde_json::from_value::<BookEdit>(serde_json::json!({
        "book_id": "1",
        "add_tag": ["x"],
    }))
    .unwrap_err();
    assert!(error.to_string().contains("add_tag"), "{error}");
}
