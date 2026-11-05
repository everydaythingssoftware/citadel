use diesel::sql_query;
use diesel::sql_types::{BigInt, Integer, Text};
use diesel::{QueryableByName, RunQueryDsl, SqliteConnection};

use crate::{CalibreError, CustomValueSummary};

pub(crate) fn list_with_book_counts(
    conn: &mut SqliteConnection,
    column_id: i32,
) -> Result<Vec<CustomValueSummary>, CalibreError> {
    #[derive(QueryableByName)]
    struct ValueRow {
        #[diesel(sql_type = Integer)]
        id: i32,
        #[diesel(sql_type = Text)]
        name: String,
        #[diesel(sql_type = BigInt)]
        book_count: i64,
    }

    let rows: Vec<ValueRow> = sql_query(format!(
        "SELECT v.id AS id, v.value AS name, COUNT(link.book) AS book_count
         FROM custom_column_{column_id} v
         LEFT JOIN books_custom_column_{column_id}_link link ON link.value = v.id
         GROUP BY v.id, v.value
         ORDER BY v.value COLLATE NOCASE, v.value, v.id"
    ))
    .load(conn)
    .map_err(CalibreError::from)?;

    Ok(rows
        .into_iter()
        .map(|row| CustomValueSummary {
            id: row.id,
            name: row.name,
            book_count: row.book_count,
        })
        .collect())
}
