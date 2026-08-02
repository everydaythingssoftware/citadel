use diesel::sql_query;
use diesel::sql_types::{BigInt, Integer, Text};
use diesel::{QueryableByName, RunQueryDsl, SqliteConnection};

use crate::{CalibreError, GenreSummary};

pub(crate) fn list_with_book_counts(
    conn: &mut SqliteConnection,
    column_id: i32,
) -> Result<Vec<GenreSummary>, CalibreError> {
    #[derive(QueryableByName)]
    struct GenreRow {
        #[diesel(sql_type = Integer)]
        id: i32,
        #[diesel(sql_type = Text)]
        name: String,
        #[diesel(sql_type = BigInt)]
        book_count: i64,
    }

    let rows: Vec<GenreRow> = sql_query(format!(
        "SELECT genre.id AS id, genre.value AS name, COUNT(link.book) AS book_count
         FROM custom_column_{column_id} genre
         LEFT JOIN books_custom_column_{column_id}_link link ON link.value = genre.id
         GROUP BY genre.id, genre.value
         ORDER BY genre.value COLLATE NOCASE, genre.value, genre.id"
    ))
    .load(conn)
    .map_err(CalibreError::from)?;

    Ok(rows
        .into_iter()
        .map(|row| GenreSummary {
            id: row.id,
            name: row.name,
            book_count: row.book_count,
        })
        .collect())
}
