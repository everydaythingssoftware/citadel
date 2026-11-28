// Integration tests for custom SQL functions
// Tests that Calibre-compatible SQL functions are properly registered

use diesel::prelude::*;
use diesel::sql_types::Text;
use libcalibre::__internals::establish_connection;

#[derive(QueryableByName)]
struct StringResult {
    #[diesel(sql_type = Text)]
    result: String,
}

#[test]
fn test_title_sort_sql_function_the() {
    // Arrange
    let mut conn = establish_connection(":memory:").unwrap();

    // Act
    let result: StringResult = diesel::sql_query("SELECT title_sort('The Great Book') as result")
        .get_result(&mut conn)
        .unwrap();

    // Assert
    assert_eq!(result.result, "Great Book, The");
}

#[test]
fn test_title_sort_sql_function_a() {
    let mut conn = establish_connection(":memory:").unwrap();

    let result: StringResult =
        diesel::sql_query("SELECT title_sort('A Tale of Two Cities') as result")
            .get_result(&mut conn)
            .unwrap();

    assert_eq!(result.result, "Tale of Two Cities, A");
}

#[test]
fn test_title_sort_sql_function_an() {
    let mut conn = establish_connection(":memory:").unwrap();

    let result: StringResult = diesel::sql_query("SELECT title_sort('An Adventure') as result")
        .get_result(&mut conn)
        .unwrap();

    assert_eq!(result.result, "Adventure, An");
}

#[test]
fn test_title_sort_sql_function_no_article() {
    let mut conn = establish_connection(":memory:").unwrap();

    let result: StringResult = diesel::sql_query("SELECT title_sort('War and Peace') as result")
        .get_result(&mut conn)
        .unwrap();

    assert_eq!(result.result, "War and Peace");
}

#[test]
fn test_uuid4_sql_function() {
    let mut conn = establish_connection(":memory:").unwrap();

    let result: StringResult = diesel::sql_query("SELECT uuid4() as result")
        .get_result(&mut conn)
        .unwrap();

    // UUID v4 format: 8-4-4-4-12 hex digits
    assert_eq!(result.result.len(), 36, "UUID should be 36 characters");
    assert_eq!(
        result.result.chars().filter(|c| *c == '-').count(),
        4,
        "UUID should have 4 dashes"
    );

    // Test that calling it twice gives different results
    let result2: StringResult = diesel::sql_query("SELECT uuid4() as result")
        .get_result(&mut conn)
        .unwrap();

    assert_ne!(
        result.result, result2.result,
        "uuid4() should generate unique values"
    );
}

#[test]
fn test_author_to_author_sort_sql_function_registered() {
    // Verify that the SQL function is properly registered and callable
    let mut conn = establish_connection(":memory:").unwrap();

    let result: StringResult =
        diesel::sql_query("SELECT author_to_author_sort('John Smith') as result")
            .get_result(&mut conn)
            .unwrap();

    assert_eq!(result.result, "Smith, John");
}

#[test]
fn test_author_to_author_sort_sql_function_complex_case() {
    // Verify a more complex case to ensure the function logic works in SQL
    let mut conn = establish_connection(":memory:").unwrap();

    let result: StringResult =
        diesel::sql_query("SELECT author_to_author_sort('Dr. John Doe Jr.') as result")
            .get_result(&mut conn)
            .unwrap();

    assert_eq!(result.result, "Doe, John, Jr.");
}

#[derive(QueryableByName)]
struct BoolResult {
    #[diesel(sql_type = diesel::sql_types::Bool)]
    result: bool,
}

#[test]
fn test_casefold_sql_function_folds_cyrillic_case() {
    let mut conn = establish_connection(":memory:").unwrap();

    let result: StringResult = diesel::sql_query("SELECT casefold('Толстой') as result")
        .get_result(&mut conn)
        .unwrap();

    assert_eq!(result.result, "толстой");
}

#[test]
fn test_casefold_simple_sql_function_keeps_sharp_s() {
    let mut conn = establish_connection(":memory:").unwrap();

    let result: StringResult = diesel::sql_query("SELECT casefold_simple('Straße') as result")
        .get_result(&mut conn)
        .unwrap();

    assert_eq!(result.result, "straße");
}

#[test]
fn test_casefold_sql_functions_return_null_for_null() {
    let mut conn = establish_connection(":memory:").unwrap();

    for function in ["casefold", "casefold_simple"] {
        let result: BoolResult =
            diesel::sql_query(format!("SELECT {function}(NULL) IS NULL as result"))
                .get_result(&mut conn)
                .unwrap();

        assert!(result.result, "{function}(NULL) must be NULL");
    }
}
