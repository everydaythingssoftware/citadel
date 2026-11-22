use std::collections::HashMap;

use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{BigInt, Integer, Text};
use diesel::{QueryDsl, RunQueryDsl, SqliteConnection};

use crate::entities::series::{NewSeries, Series};
use crate::library::SeriesSummary;
use crate::types::BookId;
use crate::CalibreError;

pub(crate) fn list_with_book_counts(
    conn: &mut SqliteConnection,
) -> Result<Vec<SeriesSummary>, CalibreError> {
    #[derive(QueryableByName)]
    struct SeriesCountRow {
        #[diesel(sql_type = Integer)]
        id: i32,
        #[diesel(sql_type = Text)]
        name: String,
        #[diesel(sql_type = BigInt)]
        book_count: i64,
    }

    let rows: Vec<SeriesCountRow> = sql_query(
        "SELECT s.id AS id, s.name AS name, COUNT(bsl.book) AS book_count
         FROM series s
         LEFT JOIN books_series_link bsl ON bsl.series = s.id
         GROUP BY s.id, s.name
         ORDER BY s.name COLLATE NOCASE, s.id",
    )
    .load(conn)
    .map_err(CalibreError::from)?;

    Ok(rows
        .into_iter()
        .map(|row| SeriesSummary {
            id: row.id,
            name: row.name,
            book_count: row.book_count,
        })
        .collect())
}

pub(crate) fn find_by_name_case_insensitive(
    conn: &mut SqliteConnection,
    series_name: &str,
) -> Result<Option<Series>, CalibreError> {
    sql_query("SELECT id, name FROM series WHERE name = ? COLLATE NOCASE LIMIT 1")
        .bind::<Text, _>(series_name)
        .get_result(conn)
        .optional()
        .map_err(CalibreError::from)
}

pub(crate) fn create(
    conn: &mut SqliteConnection,
    new_series: NewSeries,
) -> Result<Series, CalibreError> {
    use crate::schema::series::dsl::*;

    diesel::insert_into(series)
        .values(new_series)
        .returning(Series::as_returning())
        .get_result(conn)
        .map_err(CalibreError::from)
}

pub(crate) fn create_if_not_exists(
    conn: &mut SqliteConnection,
    series_name: &str,
) -> Result<Series, CalibreError> {
    match find_by_name_case_insensitive(conn, series_name)? {
        Some(existing) => Ok(existing),
        None => create(
            conn,
            NewSeries {
                name: series_name.to_string(),
            },
        ),
    }
}

pub(crate) fn link_book(
    conn: &mut SqliteConnection,
    series_id: i32,
    book_id: BookId,
) -> Result<(), CalibreError> {
    use crate::schema::books_series_link::dsl::*;

    diesel::insert_into(books_series_link)
        .values((series.eq(series_id), book.eq(book_id.as_i32())))
        .execute(conn)
        .map_err(CalibreError::from)?;

    Ok(())
}

pub(crate) fn unlink_book(
    conn: &mut SqliteConnection,
    book_id: BookId,
) -> Result<(), CalibreError> {
    use crate::schema::books_series_link::dsl::*;

    diesel::delete(books_series_link.filter(book.eq(book_id.as_i32())))
        .execute(conn)
        .map_err(CalibreError::from)?;

    Ok(())
}

/// Returns the id of the series that the book links to, or `None` if the
/// book has no series.
pub(crate) fn id_for_book(
    conn: &mut SqliteConnection,
    book_id: BookId,
) -> Result<Option<i32>, CalibreError> {
    use crate::schema::books_series_link::dsl::*;

    books_series_link
        .filter(book.eq(book_id.as_i32()))
        .select(series)
        .first::<i32>(conn)
        .optional()
        .map_err(CalibreError::from)
}

/// Deletes the series with id `series_id` if no book links to it.
pub(crate) fn delete_if_unused(
    conn: &mut SqliteConnection,
    series_id: i32,
) -> Result<(), CalibreError> {
    sql_query(
        "DELETE FROM series WHERE id = ? AND NOT EXISTS \
         (SELECT 1 FROM books_series_link link WHERE link.series = series.id)",
    )
    .bind::<Integer, _>(series_id)
    .execute(conn)?;
    Ok(())
}

/// Makes `series_id` the book's only series, replacing any existing link.
/// A book belongs to at most one series in Calibre's schema.
pub(crate) fn set_book_series(
    conn: &mut SqliteConnection,
    series_id: i32,
    book_id: BookId,
) -> Result<(), CalibreError> {
    unlink_book(conn, book_id)?;
    link_book(conn, series_id, book_id)
}

pub(crate) fn find_series_name_for_book(
    conn: &mut SqliteConnection,
    book_id: BookId,
) -> Result<Option<String>, CalibreError> {
    use crate::schema::{books_series_link, series};

    series::table
        .inner_join(books_series_link::table.on(books_series_link::series.eq(series::id)))
        .filter(books_series_link::book.eq(book_id.as_i32()))
        .select(series::name)
        .first::<String>(conn)
        .optional()
        .map_err(CalibreError::from)
}

pub(crate) fn find_series_names_by_book_ids(
    conn: &mut SqliteConnection,
    book_ids: Vec<BookId>,
) -> Result<HashMap<BookId, String>, CalibreError> {
    if book_ids.is_empty() {
        return Ok(HashMap::new());
    }

    #[derive(QueryableByName)]
    struct BookSeriesName {
        #[diesel(sql_type = Integer)]
        book_id: i32,
        #[diesel(sql_type = Text)]
        series_name: String,
    }

    let ids = book_ids
        .iter()
        .map(|book_id| book_id.as_i32().to_string())
        .collect::<Vec<_>>()
        .join(",");

    let rows: Vec<BookSeriesName> = sql_query(format!(
        "SELECT bsl.book AS book_id, s.name AS series_name
         FROM books_series_link bsl
         INNER JOIN series s ON s.id = bsl.series
         WHERE bsl.book IN ({ids})"
    ))
    .load(conn)
    .map_err(CalibreError::from)?;

    Ok(rows
        .into_iter()
        .map(|row| (BookId(row.book_id), row.series_name))
        .collect())
}
