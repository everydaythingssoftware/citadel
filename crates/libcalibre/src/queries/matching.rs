//! The narrow reads duplicate matching needs: titles, author names, ISBNs and
//! languages of every book, with no hydration.

use std::collections::HashMap;

use diesel::sql_types::{Integer, Text};
use diesel::{sql_query, QueryableByName, RunQueryDsl, SqliteConnection};

use crate::{types::BookId, CalibreError};

/// What matching compares of one book in the library.
#[derive(Debug, Default)]
pub(crate) struct BookFacts {
    pub(crate) title: String,
    pub(crate) author_names: Vec<String>,
    pub(crate) isbns: Vec<String>,
    pub(crate) languages: Vec<String>,
}

#[derive(QueryableByName)]
struct BookValue {
    #[diesel(sql_type = Integer)]
    book: i32,
    #[diesel(sql_type = Text)]
    value: String,
}

fn values(conn: &mut SqliteConnection, sql: &str) -> Result<Vec<BookValue>, CalibreError> {
    sql_query(sql).load(conn).map_err(CalibreError::from)
}

/// Every book's facts, by id, in four queries.
pub(crate) fn book_facts(
    conn: &mut SqliteConnection,
) -> Result<HashMap<BookId, BookFacts>, CalibreError> {
    let mut facts: HashMap<BookId, BookFacts> = HashMap::new();
    for row in values(conn, "SELECT id AS book, title AS value FROM books")? {
        facts.entry(BookId(row.book)).or_default().title = row.value;
    }
    let authors = values(
        conn,
        "SELECT link.book AS book, authors.name AS value
         FROM books_authors_link link
         INNER JOIN authors ON authors.id = link.author
         ORDER BY link.book, link.id",
    )?;
    for row in authors {
        if let Some(book) = facts.get_mut(&BookId(row.book)) {
            book.author_names.push(row.value);
        }
    }
    let isbns = values(
        conn,
        "SELECT book, val AS value FROM identifiers WHERE lower(type) = 'isbn'",
    )?;
    for row in isbns {
        if let Some(book) = facts.get_mut(&BookId(row.book)) {
            book.isbns.push(row.value);
        }
    }
    let languages = values(
        conn,
        "SELECT link.book AS book, languages.lang_code AS value
         FROM books_languages_link link
         INNER JOIN languages ON languages.id = link.lang_code",
    )?;
    for row in languages {
        if let Some(book) = facts.get_mut(&BookId(row.book)) {
            book.languages.push(row.value);
        }
    }
    Ok(facts)
}
