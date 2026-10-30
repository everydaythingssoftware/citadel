use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{BigInt, Integer, Text};
use diesel::{RunQueryDsl, SqliteConnection};

use crate::library::PublisherSummary;
use crate::CalibreError;

/// Every publisher with its linked-book count, sorted case-insensitively by
/// name. Includes publishers no longer linked to any book (count 0),
/// matching [`super::series::list_with_book_counts`].
pub(crate) fn list_with_book_counts(
    conn: &mut SqliteConnection,
) -> Result<Vec<PublisherSummary>, CalibreError> {
    #[derive(QueryableByName)]
    struct PublisherCountRow {
        #[diesel(sql_type = Integer)]
        id: i32,
        #[diesel(sql_type = Text)]
        name: String,
        #[diesel(sql_type = BigInt)]
        book_count: i64,
    }

    let rows: Vec<PublisherCountRow> = sql_query(
        "SELECT p.id AS id, p.name AS name, COUNT(bpl.book) AS book_count
         FROM publishers p
         LEFT JOIN books_publishers_link bpl ON bpl.publisher = p.id
         GROUP BY p.id, p.name
         ORDER BY p.name COLLATE NOCASE, p.id",
    )
    .load(conn)
    .map_err(CalibreError::from)?;

    Ok(rows
        .into_iter()
        .map(|row| PublisherSummary {
            id: row.id,
            name: row.name,
            book_count: row.book_count,
        })
        .collect())
}

/// Links the book to the named publisher, creating it if needed (matched
/// case-insensitively, as Calibre does) and replacing any earlier link:
/// Calibre allows one publisher per book.
pub(crate) fn set_for_book(
    conn: &mut SqliteConnection,
    book_id: crate::BookId,
    name: &str,
) -> Result<(), CalibreError> {
    use crate::schema::{books_publishers_link, publishers};

    let existing = publishers::table
        .filter(
            diesel::dsl::sql::<diesel::sql_types::Bool>("name = ")
                .bind::<Text, _>(name)
                .sql(" COLLATE NOCASE"),
        )
        .select(publishers::id)
        .first::<i32>(conn)
        .optional()?;
    let publisher_id = match existing {
        Some(id) => id,
        None => diesel::insert_into(publishers::table)
            .values(publishers::name.eq(name))
            .returning(publishers::id)
            .get_result(conn)?,
    };
    diesel::delete(
        books_publishers_link::table.filter(books_publishers_link::book.eq(book_id.as_i32())),
    )
    .execute(conn)?;
    diesel::insert_into(books_publishers_link::table)
        .values((
            books_publishers_link::book.eq(book_id.as_i32()),
            books_publishers_link::publisher.eq(publisher_id),
        ))
        .execute(conn)?;
    Ok(())
}
