//! Author queries
//!
//! Provides functions to interact with `authors` in the Calibre database.
//! All functions use type-safe IDs and accept a mutable SQLite connection.

// =============================================================================
// Core queries
// =============================================================================

use std::collections::HashMap;

use diesel::prelude::*;
use diesel::{QueryDsl, RunQueryDsl, SqliteConnection};

use crate::entities::author::{NewAuthor, UpdateAuthorData};
use crate::sorting;
use crate::types::BookId;
use crate::{entities::author::Author, types::AuthorId, CalibreError};

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

/// The author named `author_name`. The comparison uses the `NOCASE`
/// collation of `authors.name`, which folds ASCII case only. A non-ASCII
/// name that it misses also matches by the simple Unicode folding
/// ([`crate::casefold::find_id_by_folded_value`]).
pub(crate) fn find_by_name(
    conn: &mut SqliteConnection,
    author_name: &str,
) -> Result<Option<Author>, CalibreError> {
    use crate::schema::authors::dsl::*;

    let indexed = authors
        .filter(name.eq(author_name))
        .select(Author::as_select())
        .first(conn)
        .optional()?;
    if indexed.is_some() {
        return Ok(indexed);
    }
    let Some(folded_id) =
        crate::casefold::find_id_by_folded_value(conn, "authors", "name", author_name)?
    else {
        return Ok(None);
    };
    authors
        .find(folded_id)
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

/// Links the book to the author. A link that exists stays as it is, because
/// two names can fold to one author ([`crate::casefold::fold_simple`]).
pub(crate) fn link_book(
    conn: &mut SqliteConnection,
    author_id: AuthorId,
    book_id: BookId,
) -> Result<(), CalibreError> {
    use crate::schema::books_authors_link::dsl::*;

    diesel::insert_or_ignore_into(books_authors_link)
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
