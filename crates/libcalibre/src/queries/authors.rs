//! Author queries
//!
//! Provides functions to interact with `authors` in the Calibre database.
//! All functions use type-safe IDs and accept a mutable SQLite connection.

// =============================================================================
// Core queries
// =============================================================================

use std::collections::HashMap;

use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{BigInt, Integer, Text};
use diesel::{QueryDsl, QueryableByName, RunQueryDsl, SqliteConnection};

use crate::entities::author::{NewAuthor, UpdateAuthorData};
use crate::sorting;
use crate::types::BookId;
use crate::{library::AuthorSummary, types::AuthorId, Author, CalibreError};

pub(crate) fn list_with_book_counts(
    conn: &mut SqliteConnection,
) -> Result<Vec<AuthorSummary>, CalibreError> {
    #[derive(QueryableByName)]
    struct AuthorCountRow {
        #[diesel(sql_type = Integer)]
        id: i32,
        #[diesel(sql_type = Text)]
        name: String,
        #[diesel(sql_type = BigInt)]
        book_count: i64,
    }

    let rows: Vec<AuthorCountRow> = sql_query(
        "SELECT a.id AS id, a.name AS name, COUNT(bal.book) AS book_count
         FROM authors a
         LEFT JOIN books_authors_link bal ON bal.author = a.id
         GROUP BY a.id, a.name
         ORDER BY a.name COLLATE NOCASE, a.name, a.id",
    )
    .load(conn)
    .map_err(CalibreError::from)?;

    Ok(rows
        .into_iter()
        .map(|row| AuthorSummary {
            id: AuthorId(row.id),
            name: row.name,
            book_count: row.book_count,
        })
        .collect())
}

pub(crate) fn get(
    conn: &mut SqliteConnection,
    author_id: AuthorId,
) -> Result<Option<Author>, CalibreError> {
    use crate::schema::authors::dsl::*;

    authors
        .filter(id.eq(author_id.as_i32()))
        .select(Author::as_select())
        .first(conn)
        .optional()
        .map_err(CalibreError::from)
}

pub(crate) fn get_many(
    conn: &mut SqliteConnection,
    author_ids: Vec<AuthorId>,
) -> Result<Vec<Author>, CalibreError> {
    use crate::schema::authors::dsl::*;

    let id_values: Vec<i32> = author_ids.iter().map(|aid| aid.as_i32()).collect();

    authors
        .filter(id.eq_any(id_values))
        .select(Author::as_select())
        .load(conn)
        .map_err(CalibreError::from)
}

pub(crate) fn find_by_name(
    conn: &mut SqliteConnection,
    author_name: &str,
) -> Result<Option<Author>, CalibreError> {
    use crate::schema::authors::dsl::*;

    authors
        .filter(name.eq(author_name))
        .select(Author::as_select())
        .first(conn)
        .optional()
        .map_err(CalibreError::from)
}

pub(crate) fn all(conn: &mut SqliteConnection) -> Result<Vec<Author>, CalibreError> {
    use crate::schema::authors::dsl::*;

    authors
        .select(Author::as_select())
        .load(conn)
        .map_err(CalibreError::from)
}

/// Linked-book count per author, in one GROUP BY pass over
/// `books_authors_link`. Authors with no linked books are absent from the
/// map (their count is 0).
pub(crate) fn book_counts(
    conn: &mut SqliteConnection,
) -> Result<HashMap<AuthorId, i64>, CalibreError> {
    use diesel::dsl::count_star;

    use crate::schema::books_authors_link::dsl::*;

    let rows: Vec<(i32, i64)> = books_authors_link
        .group_by(author)
        .select((author, count_star()))
        .load(conn)
        .map_err(CalibreError::from)?;

    Ok(rows
        .into_iter()
        .map(|(author_id, book_count)| (AuthorId(author_id), book_count))
        .collect())
}

pub(crate) fn create(
    conn: &mut SqliteConnection,
    new_author: NewAuthor,
) -> Result<Author, CalibreError> {
    use crate::schema::authors::dsl::*;

    diesel::insert_into(authors)
        .values(new_author)
        .returning(Author::as_returning())
        .get_result(conn)
        .map_err(CalibreError::from)
}

pub(crate) fn create_if_not_exists(
    conn: &mut SqliteConnection,
    author_name: &str,
) -> Result<Author, CalibreError> {
    match find_by_name(conn, author_name)? {
        Some(existing) => Ok(existing),

        None => {
            let new_author = NewAuthor {
                name: author_name.to_string(),
                sort: Some(sorting::sort_author_name_apa(author_name)),
                link: None,
            };

            create(conn, new_author)
        }
    }
}

pub(crate) fn update(
    conn: &mut SqliteConnection,
    author_id: AuthorId,
    update: UpdateAuthorData,
) -> Result<Author, CalibreError> {
    use crate::schema::authors::dsl::*;

    diesel::update(authors.filter(id.eq(author_id.as_i32())))
        .set(&update)
        .returning(Author::as_returning())
        .get_result(conn)
        .map_err(CalibreError::from)
}

pub(crate) fn delete(conn: &mut SqliteConnection, author_id: AuthorId) -> Result<(), CalibreError> {
    use crate::schema::authors::dsl::*;

    diesel::delete(authors.filter(id.eq(author_id.as_i32())))
        .execute(conn)
        .map_err(CalibreError::from)?;

    Ok(())
}

// =============================================================================
// Relationships
// =============================================================================

pub(crate) fn find_books(
    conn: &mut SqliteConnection,
    author_id: AuthorId,
) -> Result<Vec<BookId>, CalibreError> {
    use crate::schema::books_authors_link::dsl::*;

    let book_ids: Vec<BookId> = books_authors_link
        .filter(author.eq(author_id.as_i32()))
        .select(book)
        .load(conn)?
        .into_iter()
        .map(BookId)
        .collect();

    Ok(book_ids)
}

pub(crate) fn link_book(
    conn: &mut SqliteConnection,
    author_id: AuthorId,
    book_id: BookId,
) -> Result<(), CalibreError> {
    use crate::schema::books_authors_link::dsl::*;

    diesel::insert_into(books_authors_link)
        .values((author.eq(author_id.as_i32()), book.eq(book_id.as_i32())))
        .execute(conn)
        .map_err(CalibreError::from)?;

    Ok(())
}

pub(crate) fn unlink_book(
    conn: &mut SqliteConnection,
    author_id: AuthorId,
    book_id: BookId,
) -> Result<(), CalibreError> {
    use crate::schema::books_authors_link::dsl::*;

    diesel::delete(
        books_authors_link
            .filter(author.eq(author_id.as_i32()))
            .filter(book.eq(book_id.as_i32())),
    )
    .execute(conn)
    .map_err(CalibreError::from)?;

    Ok(())
}

pub(crate) fn find_author_ids_by_book_ids(
    conn: &mut SqliteConnection,
    book_ids: Vec<BookId>,
) -> Result<HashMap<BookId, Vec<AuthorId>>, CalibreError> {
    use crate::schema::books_authors_link::dsl::*;

    let ids: Vec<i32> = book_ids.iter().map(|bid| bid.as_i32()).collect();

    let links = books_authors_link
        .filter(book.eq_any(ids))
        .select((book, author))
        .load::<(i32, i32)>(conn)
        .map_err(CalibreError::from)?;

    let mut grouped: HashMap<BookId, Vec<AuthorId>> = HashMap::new();
    for (book_id_val, author_id_val) in links {
        grouped
            .entry(BookId(book_id_val))
            .or_insert_with(Vec::new)
            .push(AuthorId(author_id_val));
    }

    Ok(grouped)
}

// =============================================================================
// Tests
// =============================================================================

// TODO
