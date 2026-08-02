//! Book queries
//!
//! Provides functions to interact with `books` in the Calibre database.
//! All functions use type-safe IDs and accept a mutable SQLite connection.

use diesel::prelude::*;
use diesel::sql_types::{BigInt, Integer, Text};
use diesel::{sql_query, QueryDsl, QueryableByName, RunQueryDsl, SqliteConnection};

use crate::library::BookSortOrder;
use crate::types::AuthorId;
use crate::{types::BookId, CalibreError};
use crate::{BookRow, NewBook, UpdateBookData};

// =============================================================================
// Core queries
// =============================================================================

pub(crate) fn get(
    conn: &mut SqliteConnection,
    book_id: BookId,
) -> Result<Option<BookRow>, CalibreError> {
    use crate::schema::books::dsl::*;

    books
        .filter(id.eq(book_id.as_i32()))
        .select(BookRow::as_select())
        .first(conn)
        .optional()
        .map_err(CalibreError::from)
}

pub(crate) fn all(conn: &mut SqliteConnection) -> Result<Vec<BookRow>, CalibreError> {
    use crate::schema::books::dsl::*;

    books
        .select(BookRow::as_select())
        .load(conn)
        .map_err(CalibreError::from)
}

pub(crate) fn get_by_ids(
    conn: &mut SqliteConnection,
    book_ids: Vec<BookId>,
) -> Result<Vec<BookRow>, CalibreError> {
    use crate::schema::books::dsl::*;

    let raw_ids: Vec<i32> = book_ids.iter().map(BookId::as_i32).collect();

    books
        .filter(id.eq_any(raw_ids))
        .select(BookRow::as_select())
        .load(conn)
        .map_err(CalibreError::from)
}

/// `(id, path)` for every book with a cover, without any hydration. Selects
/// only the `books` table — no authors/tags/series/files/read-state — so the
/// cover-thumbnail warm path can read each cover's folder cheaply. A NULL
/// `has_cover` is treated as false.
pub(crate) fn cover_sources(
    conn: &mut SqliteConnection,
) -> Result<Vec<(BookId, String)>, CalibreError> {
    use crate::schema::books::dsl::*;

    books
        .filter(has_cover.eq(true))
        .select((id, path))
        .load::<(i32, String)>(conn)
        .map(|rows| rows.into_iter().map(|(i, p)| (BookId(i), p)).collect())
        .map_err(CalibreError::from)
}

/// Like [`cover_sources`], but restricted to the given ids. Returns only the
/// ids that exist AND have a cover (NULL `has_cover` treated as false), so the
/// caller's per-id `has_cover` filter is preserved.
pub(crate) fn cover_sources_for(
    conn: &mut SqliteConnection,
    book_ids: &[BookId],
) -> Result<Vec<(BookId, String)>, CalibreError> {
    use crate::schema::books::dsl::*;

    let raw_ids: Vec<i32> = book_ids.iter().map(BookId::as_i32).collect();

    books
        .filter(id.eq_any(raw_ids))
        .filter(has_cover.eq(true))
        .select((id, path))
        .load::<(i32, String)>(conn)
        .map(|rows| rows.into_iter().map(|(i, p)| (BookId(i), p)).collect())
        .map_err(CalibreError::from)
}

// =============================================================================
// Paged, sorted, filtered queries
// =============================================================================

/// Filters shared by the paged id query and its COUNT twin. Both build their
/// WHERE clause from [`filter_where_sql`] so the page and total cannot drift.
pub(crate) struct BookPageFilters<'a> {
    /// Case-insensitive substring match (LIKE wildcards escaped) across the
    /// book title, linked author names, and linked series names.
    pub text: Option<&'a str>,
    pub author_id: Option<AuthorId>,
    pub series_id: Option<i32>,
    pub tag_id: Option<i32>,
    pub genre_column: Option<(i32, i32)>,
    /// Id of the `read` bool custom column. When set, books marked read are
    /// excluded.
    pub hide_read_column: Option<i32>,
    pub require_file: bool,
}

#[derive(QueryableByName)]
struct IdRow {
    #[diesel(sql_type = Integer)]
    id: i32,
}

#[derive(QueryableByName)]
struct CountRow {
    #[diesel(sql_type = BigInt)]
    total: i64,
}

#[derive(QueryableByName)]
pub(crate) struct AcquisitionCandidate {
    #[diesel(sql_type = Integer)]
    pub book_id: i32,
    #[diesel(sql_type = Text)]
    pub book_path: String,
    #[diesel(sql_type = Text)]
    pub format: String,
    #[diesel(sql_type = Text)]
    pub name: String,
}

fn like_pattern(text: &str) -> String {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// WHERE clause shared by [`query_page`] and [`query_count`]. The text filter
/// uses three `?` placeholders (title, author name, series name); all other
/// filters interpolate plain integers.
fn filter_where_sql(filters: &BookPageFilters) -> String {
    let mut clauses: Vec<String> = vec!["1=1".to_string()];

    if filters.text.is_some() {
        clauses.push(
            "(books.title LIKE ? ESCAPE '\\' \
              OR EXISTS (SELECT 1 FROM books_authors_link bal \
                         JOIN authors a ON a.id = bal.author \
                         WHERE bal.book = books.id AND a.name LIKE ? ESCAPE '\\') \
              OR EXISTS (SELECT 1 FROM books_series_link bsl \
                         JOIN series s ON s.id = bsl.series \
                         WHERE bsl.book = books.id AND s.name LIKE ? ESCAPE '\\'))"
                .to_string(),
        );
    }

    if let Some(author_id) = filters.author_id {
        clauses.push(format!(
            "EXISTS (SELECT 1 FROM books_authors_link bal2 \
             WHERE bal2.book = books.id AND bal2.author = {})",
            author_id.as_i32()
        ));
    }

    if let Some(series_id) = filters.series_id {
        clauses.push(format!(
            "EXISTS (SELECT 1 FROM books_series_link bsl2 \
             WHERE bsl2.book = books.id AND bsl2.series = {series_id})"
        ));
    }

    if let Some(tag_id) = filters.tag_id {
        clauses.push(format!(
            "EXISTS (SELECT 1 FROM books_tags_link btl2 \
             WHERE btl2.book = books.id AND btl2.tag = {tag_id})"
        ));
    }

    if let Some((column_id, genre_id)) = filters.genre_column {
        clauses.push(format!(
            "EXISTS (SELECT 1 FROM books_custom_column_{column_id}_link gc \
             WHERE gc.book = books.id AND gc.value = {genre_id})"
        ));
    }

    if let Some(n) = filters.hide_read_column {
        clauses.push(format!(
            "NOT EXISTS (SELECT 1 FROM custom_column_{n} cc \
             WHERE cc.book = books.id AND cc.value != 0)"
        ));
    }

    if filters.require_file {
        clauses.push("EXISTS (SELECT 1 FROM data d WHERE d.book = books.id)".to_string());
    }

    clauses.join(" AND ")
}

/// ORDER BY clause for [`query_page`]. Uses Calibre's precomputed sort
/// columns (`books.sort` for titles, the primary linked author's
/// `authors.sort` for authors), with `books.id` as a stable tiebreak.
fn order_by_sql(sort: BookSortOrder) -> String {
    const AUTHOR_SORT: &str = "(SELECT a.sort FROM books_authors_link bal \
         JOIN authors a ON a.id = bal.author \
         WHERE bal.book = books.id ORDER BY bal.id LIMIT 1)";

    match sort {
        BookSortOrder::TitleAsc => "books.sort ASC, books.id ASC".to_string(),
        BookSortOrder::TitleDesc => "books.sort DESC, books.id DESC".to_string(),
        BookSortOrder::AuthorAsc => format!("{AUTHOR_SORT} ASC, books.id ASC"),
        BookSortOrder::AuthorDesc => format!("{AUTHOR_SORT} DESC, books.id DESC"),
        BookSortOrder::UpdatedDesc => "books.last_modified DESC, books.id DESC".to_string(),
        BookSortOrder::SeriesIndexAsc => {
            "books.series_index IS NULL ASC, books.series_index ASC, books.sort ASC, books.id ASC"
                .to_string()
        }
    }
}

pub(crate) fn acquisition_candidates(
    conn: &mut SqliteConnection,
    filters: &BookPageFilters,
    sort: BookSortOrder,
) -> Result<Vec<AcquisitionCandidate>, CalibreError> {
    let where_sql = filter_where_sql(filters);
    let order_sql = order_by_sql(sort);
    let sql = format!(
        "SELECT books.id AS book_id, books.path AS book_path, \
         data.format AS format, data.name AS name \
         FROM books JOIN data ON data.book = books.id \
         WHERE {where_sql} ORDER BY {order_sql}, data.id ASC"
    );

    match filters.text {
        Some(text) => {
            let pattern = like_pattern(text);
            sql_query(sql)
                .bind::<Text, _>(&pattern)
                .bind::<Text, _>(&pattern)
                .bind::<Text, _>(&pattern)
                .load(conn)
                .map_err(CalibreError::from)
        }
        None => sql_query(sql).load(conn).map_err(CalibreError::from),
    }
}

/// One page of matching book ids, in sorted order. `limit: None` returns all
/// matches (after `offset`).
pub(crate) fn query_page(
    conn: &mut SqliteConnection,
    filters: &BookPageFilters,
    sort: BookSortOrder,
    limit: Option<i64>,
    offset: i64,
) -> Result<Vec<BookId>, CalibreError> {
    let where_sql = filter_where_sql(filters);
    let order_sql = order_by_sql(sort);
    // SQLite treats a negative LIMIT as "no limit"; OFFSET still applies.
    let limit = limit.map(|l| l.max(0)).unwrap_or(-1);
    let offset = offset.max(0);

    let sql = format!(
        "SELECT books.id FROM books WHERE {where_sql} \
         ORDER BY {order_sql} LIMIT {limit} OFFSET {offset}"
    );

    let rows: Vec<IdRow> = match filters.text {
        Some(text) => {
            let pattern = like_pattern(text);
            sql_query(sql)
                .bind::<Text, _>(&pattern)
                .bind::<Text, _>(&pattern)
                .bind::<Text, _>(&pattern)
                .load(conn)
                .map_err(CalibreError::from)?
        }
        None => sql_query(sql).load(conn).map_err(CalibreError::from)?,
    };

    Ok(rows.into_iter().map(|row| BookId(row.id)).collect())
}

/// COUNT over the same WHERE as [`query_page`], ignoring limit/offset.
pub(crate) fn query_count(
    conn: &mut SqliteConnection,
    filters: &BookPageFilters,
) -> Result<i64, CalibreError> {
    let where_sql = filter_where_sql(filters);
    let sql = format!("SELECT COUNT(*) AS total FROM books WHERE {where_sql}");

    let rows: Vec<CountRow> = match filters.text {
        Some(text) => {
            let pattern = like_pattern(text);
            sql_query(sql)
                .bind::<Text, _>(&pattern)
                .bind::<Text, _>(&pattern)
                .bind::<Text, _>(&pattern)
                .load(conn)
                .map_err(CalibreError::from)?
        }
        None => sql_query(sql).load(conn).map_err(CalibreError::from)?,
    };

    Ok(rows.first().map(|row| row.total).unwrap_or(0))
}

pub(crate) fn create(conn: &mut SqliteConnection, book: NewBook) -> Result<BookRow, CalibreError> {
    use crate::schema::books::dsl::*;

    diesel::insert_into(books)
        .values(book)
        .returning(BookRow::as_returning())
        .get_result(conn)
        .map_err(CalibreError::from)
}

pub(crate) fn update(
    conn: &mut SqliteConnection,
    book_id: BookId,
    update: UpdateBookData,
) -> Result<usize, CalibreError> {
    use crate::schema::books::dsl::*;

    diesel::update(books.filter(id.eq(book_id.as_i32())))
        .set(update)
        .execute(conn)
        .map_err(CalibreError::from)
}

pub(crate) fn touch(conn: &mut SqliteConnection, book_id: BookId) -> Result<usize, CalibreError> {
    use crate::schema::books::dsl::{books, id, last_modified};

    let previous = books
        .filter(id.eq(book_id.as_i32()))
        .select(last_modified)
        .first::<chrono::NaiveDateTime>(conn)?;
    let updated_at = std::cmp::max(
        chrono::Utc::now().naive_utc(),
        previous + chrono::TimeDelta::microseconds(1),
    );
    diesel::update(books.filter(id.eq(book_id.as_i32())))
        .set(last_modified.eq(updated_at))
        .execute(conn)
        .map_err(CalibreError::from)
}

pub(crate) fn touch_many(
    conn: &mut SqliteConnection,
    book_ids: &[BookId],
) -> Result<usize, CalibreError> {
    use crate::schema::books::dsl::{books, id, last_modified};

    if book_ids.is_empty() {
        return Ok(0);
    }
    let previous = books
        .filter(id.eq_any(book_ids.iter().map(|book_id| book_id.as_i32())))
        .select(diesel::dsl::max(last_modified))
        .first::<Option<chrono::NaiveDateTime>>(conn)?;
    let updated_at = previous
        .map(|previous| {
            std::cmp::max(
                chrono::Utc::now().naive_utc(),
                previous + chrono::TimeDelta::microseconds(1),
            )
        })
        .unwrap_or_else(|| chrono::Utc::now().naive_utc());
    let ids = book_ids.iter().map(|book_id| book_id.as_i32());
    diesel::update(books.filter(id.eq_any(ids)))
        .set(last_modified.eq(updated_at))
        .execute(conn)
        .map_err(CalibreError::from)
}

pub(crate) fn touch_catalog(conn: &mut SqliteConnection) -> Result<usize, CalibreError> {
    use crate::schema::books::dsl::{books, id};

    match books
        .select(id)
        .order(id.asc())
        .first::<i32>(conn)
        .optional()?
    {
        Some(book_id) => touch(conn, BookId(book_id)),
        None => Ok(0),
    }
}

pub(crate) fn delete(conn: &mut SqliteConnection, book_id: BookId) -> Result<bool, CalibreError> {
    use crate::schema::books::dsl::*;

    diesel::delete(books.filter(id.eq(book_id.as_i32())))
        .execute(conn)
        .map_err(CalibreError::from)
        .map(|affected_rows| affected_rows > 0)
}

// =============================================================================
// Relationships
// =============================================================================

pub(crate) fn find_authors(
    conn: &mut SqliteConnection,
    book_id: BookId,
) -> Result<Vec<AuthorId>, CalibreError> {
    use crate::schema::books_authors_link::dsl::*;

    let author_ids: Vec<AuthorId> = books_authors_link
        .filter(book.eq(book_id.as_i32()))
        .select(author)
        .load(conn)
        .map(|ids: Vec<i32>| ids.into_iter().map(AuthorId).collect())
        .map_err(CalibreError::from)?;

    Ok(author_ids)
}
