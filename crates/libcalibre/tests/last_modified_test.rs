// Regression tests for https://github.com/everydaythingssoftware/citadel/issues/157:
// metadata edits must bump `books.last_modified` only when a value actually changes,
// matching Calibre's `Cache.set_field()` -> `_update_last_modified(dirtied)`.
mod common;

use common::{setup_with_library, standard_test_book};
use libcalibre::{BookId, CustomColumnKind, CustomColumnSpec, CustomValue, Library};

fn add_book(lib: &mut Library) -> BookId {
    lib.add_book(standard_test_book()).unwrap().id
}

fn last_modified(lib: &mut Library, book: BookId) -> chrono::NaiveDateTime {
    lib.get_book(book).unwrap().updated_at
}

fn add_bool_column(lib: &mut Library) -> i32 {
    lib.create_custom_column(CustomColumnSpec {
        label: "finished".to_string(),
        name: "Finished".to_string(),
        kind: CustomColumnKind::Bool,
        is_multiple: false,
        enum_values: vec![],
        display: None,
    })
    .unwrap()
    .id
}

#[test]
fn test_set_custom_value_touches_last_modified() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);
    let col = add_bool_column(&mut lib);

    let before = last_modified(&mut lib, book);

    lib.set_custom_value(book, col, Some(CustomValue::Bool(true)))
        .unwrap();

    let after = last_modified(&mut lib, book);
    assert!(
        after > before,
        "last_modified must advance after a custom-value edit (before={before:?}, after={after:?})"
    );
}

#[test]
fn test_set_book_read_state_touches_last_modified() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);

    let before = last_modified(&mut lib, book);

    lib.set_book_read_state(book, true).unwrap();

    let after = last_modified(&mut lib, book);
    assert!(
        after > before,
        "last_modified must advance after a read-state edit (before={before:?}, after={after:?})"
    );
}

#[test]
fn test_unchanged_custom_value_leaves_last_modified() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);
    let col = add_bool_column(&mut lib);
    lib.set_custom_value(book, col, Some(CustomValue::Bool(true)))
        .unwrap();

    let before = last_modified(&mut lib, book);

    lib.set_custom_value(book, col, Some(CustomValue::Bool(true)))
        .unwrap();

    assert_eq!(last_modified(&mut lib, book), before);
}

#[test]
fn test_unchanged_read_state_leaves_last_modified() {
    let (_temp, mut lib) = setup_with_library();
    let book = add_book(&mut lib);
    lib.set_book_read_state(book, true).unwrap();

    let before = last_modified(&mut lib, book);

    lib.set_book_read_state(book, true).unwrap();

    assert_eq!(last_modified(&mut lib, book), before);
}
