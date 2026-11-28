//! Book queries
//!
//! Provides functions to interact with `books` in the Calibre database.
//! All functions use type-safe IDs and accept a mutable SQLite connection.

use diesel::prelude::*;
use diesel::sql_types::{BigInt, Integer, Text};
use diesel::sqlite::Sqlite;
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
pub(crate) struct BookPageFilters {
    /// The compiled search text: a condition on `books`, with its binds.
    pub search: Option<SqlFragment>,
    pub author_id: Option<AuthorId>,
    pub series_id: Option<i32>,
    pub tag_id: Option<i32>,
    pub publisher_id: Option<i32>,
    /// Only books linked to one value of a custom column.
    pub custom_value: Option<ResolvedCustomValue>,
    /// Id of the read-state bool custom column. When set, books marked read are
    /// excluded.
    pub hide_read_column: Option<i32>,
}

/// A [`crate::CustomValueFilter`] after the lookup of its column.
pub(crate) enum ResolvedCustomValue {
    /// Only books linked to the value `value_id` of the column `column_id`.
    Value { column_id: i32, value_id: i32 },
    /// The library has no column with the label, so no book matches.
    MissingColumn,
}

/// A piece of SQL with the text values that its `?` placeholders bind, in
/// the sequence of the placeholders. Each constructor adds the SQL text and
/// its binds in one step, so that the two stay in the same sequence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SqlFragment {
    /// The SQL text, with one `?` for each value in `binds`.
    sql: String,
    /// The values of the `?` placeholders, first placeholder first.
    binds: Vec<String>,
}

impl SqlFragment {
    /// Make a fragment. `sql` must hold one `?` for each value of `binds`.
    pub(crate) fn new(sql: impl Into<String>, binds: Vec<String>) -> Self {
        let sql = sql.into();
        debug_assert_eq!(
            sql.matches('?').count(),
            binds.len(),
            "each `?` needs one bind: {sql}"
        );
        Self { sql, binds }
    }

    /// Make a fragment of SQL text that has no placeholder.
    pub(crate) fn plain(sql: impl Into<String>) -> Self {
        Self::new(sql, Vec::new())
    }

    /// Put SQL text with no placeholder before and after the fragment.
    pub(crate) fn wrap(self, before: &str, after: &str) -> Self {
        Self::new(format!("{before}{}{after}", self.sql), self.binds)
    }

    /// Join fragments with `separator`, in sequence.
    pub(crate) fn join(parts: impl IntoIterator<Item = SqlFragment>, separator: &str) -> Self {
        let mut sql = Vec::new();
        let mut binds = Vec::new();
        for part in parts {
            sql.push(part.sql);
            binds.extend(part.binds);
        }
        Self::new(sql.join(separator), binds)
    }

    /// The SQL text.
    #[cfg(test)]
    pub(crate) fn sql(&self) -> &str {
        &self.sql
    }

    /// The values of the `?` placeholders, first placeholder first.
    #[cfg(test)]
    pub(crate) fn binds(&self) -> &[String] {
        &self.binds
    }

    /// The SQL text and the binds.
    #[cfg(feature = "__internals")]
    pub(crate) fn into_parts(self) -> (String, Vec<String>) {
        (self.sql, self.binds)
    }
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

/// Wraps `text` in `%` wildcards for a LIKE match. A backslash escapes each
/// `%`, `_` and `\` of `text`.
pub(crate) fn like_pattern(text: &str) -> String {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// WHERE clause shared by [`query_page`] and [`query_count`], returned with
/// its binds. The search filter uses one `?` placeholder for each of its
/// binds; all other filters interpolate plain integers.
fn filter_where_sql(filters: &BookPageFilters) -> SqlFragment {
    let mut clauses: Vec<SqlFragment> = vec![SqlFragment::plain("1=1")];

    if let Some(search) = &filters.search {
        clauses.push(search.clone().wrap("(", ")"));
    }

    if let Some(author_id) = filters.author_id {
        clauses.push(SqlFragment::plain(format!(
            "EXISTS (SELECT 1 FROM books_authors_link bal2 \
             WHERE bal2.book = books.id AND bal2.author = {})",
            author_id.as_i32()
        )));
    }

    if let Some(series_id) = filters.series_id {
        clauses.push(SqlFragment::plain(format!(
            "EXISTS (SELECT 1 FROM books_series_link bsl2 \
             WHERE bsl2.book = books.id AND bsl2.series = {series_id})"
        )));
    }

    if let Some(tag_id) = filters.tag_id {
        clauses.push(SqlFragment::plain(format!(
            "EXISTS (SELECT 1 FROM books_tags_link btl2 \
             WHERE btl2.book = books.id AND btl2.tag = {tag_id})"
        )));
    }

    if let Some(publisher_id) = filters.publisher_id {
        clauses.push(SqlFragment::plain(format!(
            "EXISTS (SELECT 1 FROM books_publishers_link bpl2 \
             WHERE bpl2.book = books.id AND bpl2.publisher = {publisher_id})"
        )));
    }

    match filters.custom_value {
        Some(ResolvedCustomValue::Value {
            column_id,
            value_id,
        }) => clauses.push(SqlFragment::plain(format!(
            "EXISTS (SELECT 1 FROM books_custom_column_{column_id}_link cvl \
             WHERE cvl.book = books.id AND cvl.value = {value_id})"
        ))),
        Some(ResolvedCustomValue::MissingColumn) => clauses.push(SqlFragment::plain("0 = 1")),
        None => {}
    }

    if let Some(n) = filters.hide_read_column {
        clauses.push(SqlFragment::plain(format!(
            "NOT EXISTS (SELECT 1 FROM custom_column_{n} cc \
             WHERE cc.book = books.id AND cc.value != 0)"
        )));
    }

    SqlFragment::join(clauses, " AND ")
}

/// Runs `query` and loads its rows. It binds each value of `query.binds` as
/// text, in sequence. In a debug build, [`SqlFragment::new`] makes sure that
/// each `?` has one bind.
fn load_rows<T>(conn: &mut SqliteConnection, query: SqlFragment) -> Result<Vec<T>, CalibreError>
where
    T: QueryableByName<Sqlite> + 'static,
{
    let mut statement = sql_query(query.sql).into_boxed::<Sqlite>();
    for value in query.binds {
        statement = statement.bind::<Text, _>(value);
    }
    statement.load(conn).map_err(CalibreError::from)
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
        BookSortOrder::AddedDesc => "books.timestamp DESC, books.id DESC".to_string(),
        BookSortOrder::AddedAsc => "books.timestamp ASC, books.id ASC".to_string(),
        BookSortOrder::UpdatedDesc => "books.last_modified DESC, books.id DESC".to_string(),
        BookSortOrder::SeriesIndexAsc => {
            "books.series_index IS NULL ASC, books.series_index ASC, books.sort ASC, books.id ASC"
                .to_string()
        }
    }
}

/// The SQL of [`query_page`], with its binds.
pub(crate) fn page_sql(
    filters: &BookPageFilters,
    sort: BookSortOrder,
    limit: Option<i64>,
    offset: i64,
) -> SqlFragment {
    let order_sql = order_by_sql(sort);
    // SQLite treats a negative LIMIT as "no limit"; OFFSET still applies.
    let limit = limit.map(|l| l.max(0)).unwrap_or(-1);
    let offset = offset.max(0);
    filter_where_sql(filters).wrap(
        "SELECT books.id FROM books WHERE ",
        &format!(" ORDER BY {order_sql} LIMIT {limit} OFFSET {offset}"),
    )
}

/// The SQL of [`query_count`], with its binds.
pub(crate) fn count_sql(filters: &BookPageFilters) -> SqlFragment {
    filter_where_sql(filters).wrap("SELECT COUNT(*) AS total FROM books WHERE ", "")
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
    let rows: Vec<IdRow> = load_rows(conn, page_sql(filters, sort, limit, offset))?;

    Ok(rows.into_iter().map(|row| BookId(row.id)).collect())
}

/// COUNT over the same WHERE as [`query_page`], ignoring limit/offset.
/// SQLite COUNT is non-negative, so the boundary conversion to u64 is total
/// in practice; a nonsensical negative maps to 0.
pub(crate) fn query_count(
    conn: &mut SqliteConnection,
    filters: &BookPageFilters,
) -> Result<u64, CalibreError> {
    let rows: Vec<CountRow> = load_rows(conn, count_sql(filters))?;

    Ok(rows
        .first()
        .map(|row| u64::try_from(row.total).unwrap_or(0))
        .unwrap_or(0))
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
    let touched = bump_last_modified(conn, book_id)?;
    mark_dirty(conn, &[book_id])?;
    Ok(touched)
}

/// Queues books for Calibre's `metadata.opf` backup: Calibre rewrites the
/// file of each book in `metadata_dirtied`, then removes it from the queue.
pub(crate) fn mark_dirty(
    conn: &mut SqliteConnection,
    book_ids: &[BookId],
) -> Result<(), CalibreError> {
    for book_id in book_ids {
        diesel::sql_query("INSERT OR IGNORE INTO metadata_dirtied (book) VALUES (?)")
            .bind::<diesel::sql_types::Integer, _>(book_id.as_i32())
            .execute(conn)?;
    }
    Ok(())
}

fn bump_last_modified(conn: &mut SqliteConnection, book_id: BookId) -> Result<usize, CalibreError> {
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
    let touched = diesel::update(books.filter(id.eq_any(ids)))
        .set(last_modified.eq(updated_at))
        .execute(conn)?;
    mark_dirty(conn, book_ids)?;
    Ok(touched)
}

pub(crate) fn touch_catalog(conn: &mut SqliteConnection) -> Result<usize, CalibreError> {
    use crate::schema::books::dsl::{books, id};

    match books
        .select(id)
        .order(id.asc())
        .first::<i32>(conn)
        .optional()?
    {
        Some(book_id) => bump_last_modified(conn, BookId(book_id)),
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

pub(crate) fn acquisition_candidates(
    conn: &mut SqliteConnection,
    filters: &BookPageFilters,
    sort: BookSortOrder,
) -> Result<Vec<AcquisitionCandidate>, CalibreError> {
    let order_sql = order_by_sql(sort);
    let query = filter_where_sql(filters).wrap(
        "SELECT books.id AS book_id, books.path AS book_path, \
         data.format AS format, data.name AS name \
         FROM books JOIN data ON data.book = books.id WHERE ",
        &format!(" ORDER BY {order_sql}, data.id ASC"),
    );

    load_rows(conn, query)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::{compile, SearchScope};

    /// A filter set with no filter except the given search.
    fn filters_with(search: Option<SqlFragment>) -> BookPageFilters {
        BookPageFilters {
            search,
            author_id: None,
            series_id: None,
            tag_id: None,
            publisher_id: None,
            custom_value: None,
            hide_read_column: None,
        }
    }

    #[test]
    fn placeholders_match_binds_with_a_search() {
        let compiled = compile(
            "tolkien tags:fantasy or title:\"the hobbit\"",
            SearchScope::AllFields,
        )
        .unwrap()
        .unwrap();
        let fragment = filter_where_sql(&filters_with(Some(compiled.fragment)));
        assert!(!fragment.binds().is_empty());
        assert_eq!(fragment.sql().matches('?').count(), fragment.binds().len());
    }

    #[test]
    fn placeholders_match_binds_without_a_search() {
        let fragment = filter_where_sql(&filters_with(None));
        assert!(fragment.binds().is_empty());
        assert_eq!(fragment.sql().matches('?').count(), 0);
    }

    #[test]
    fn join_and_wrap_keep_the_binds_in_sequence() {
        let joined = SqlFragment::join(
            [
                SqlFragment::new("a = ?", vec!["1".into()]),
                SqlFragment::plain("b = 2"),
                SqlFragment::new("c = ?", vec!["3".into()]),
            ],
            " AND ",
        )
        .wrap("(", ")");
        assert_eq!(joined.sql(), "(a = ? AND b = 2 AND c = ?)");
        assert_eq!(joined.binds(), ["1", "3"]);
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "each `?` needs one bind")]
    fn a_placeholder_without_a_bind_is_refused() {
        let _ = SqlFragment::plain("a = ?");
    }
}
