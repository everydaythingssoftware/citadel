//! A book's publisher, rating and identifiers: one row per book in a link or
//! child table, read in bulk for hydration and replaced as a whole on update.

use std::collections::HashMap;

use chrono::{NaiveDate, NaiveDateTime};
use diesel::sql_query;
use diesel::sql_types::{Integer, Text};
use diesel::{QueryableByName, RunQueryDsl, SqliteConnection};

use crate::{types::BookId, CalibreError};

/// Calibre's stand-in for "no date": year 101, not year 1.
pub(crate) fn undefined_date() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(101, 1, 1)
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .expect("valid date")
}

/// `None` for Calibre's undefined date, or anything earlier.
pub(crate) fn defined_date(stored: Option<NaiveDateTime>) -> Option<NaiveDate> {
    stored
        .filter(|date| *date > undefined_date())
        .map(|date| date.date())
}

fn id_list(book_ids: &[BookId]) -> String {
    book_ids
        .iter()
        .map(|id| id.as_i32().to_string())
        .collect::<Vec<_>>()
        .join(",")
}

/// Each book's publisher. Calibre allows one; with several links the oldest
/// wins.
pub(crate) fn publishers_by_book_ids(
    conn: &mut SqliteConnection,
    book_ids: &[BookId],
) -> Result<HashMap<BookId, String>, CalibreError> {
    #[derive(QueryableByName)]
    struct Row {
        #[diesel(sql_type = Integer)]
        book: i32,
        #[diesel(sql_type = Text)]
        name: String,
    }
    if book_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<Row> = sql_query(format!(
        "SELECT l.book AS book, p.name AS name FROM books_publishers_link l \
         JOIN publishers p ON p.id = l.publisher \
         WHERE l.book IN ({}) ORDER BY l.id DESC",
        id_list(book_ids)
    ))
    .load(conn)?;
    Ok(rows
        .into_iter()
        .map(|row| (BookId(row.book), row.name))
        .collect())
}

/// Each book's rating, 1 to 10 (half stars). Books rated 0 are unrated and
/// absent.
pub(crate) fn ratings_by_book_ids(
    conn: &mut SqliteConnection,
    book_ids: &[BookId],
) -> Result<HashMap<BookId, i32>, CalibreError> {
    #[derive(QueryableByName)]
    struct Row {
        #[diesel(sql_type = Integer)]
        book: i32,
        #[diesel(sql_type = Integer)]
        rating: i32,
    }
    if book_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<Row> = sql_query(format!(
        "SELECT l.book AS book, CAST(r.rating AS INTEGER) AS rating FROM books_ratings_link l \
         JOIN ratings r ON r.id = l.rating \
         WHERE l.book IN ({}) AND r.rating > 0 ORDER BY l.id DESC",
        id_list(book_ids)
    ))
    .load(conn)?;
    Ok(rows
        .into_iter()
        .map(|row| (BookId(row.book), row.rating))
        .collect())
}

/// Removes the book's publisher link. The publisher itself stays, as
/// Calibre keeps it.
pub(crate) fn unlink_publisher(
    conn: &mut SqliteConnection,
    book_id: BookId,
) -> Result<(), CalibreError> {
    sql_query("DELETE FROM books_publishers_link WHERE book = ?")
        .bind::<Integer, _>(book_id.as_i32())
        .execute(conn)?;
    Ok(())
}

/// Sets the book's rating, 0 to 10; 0 leaves it unrated.
pub(crate) fn set_rating(
    conn: &mut SqliteConnection,
    book_id: BookId,
    rating: i32,
) -> Result<(), CalibreError> {
    if !(0..=10).contains(&rating) {
        return Err(CalibreError::InvalidRating(rating));
    }
    sql_query("DELETE FROM books_ratings_link WHERE book = ?")
        .bind::<Integer, _>(book_id.as_i32())
        .execute(conn)?;
    if rating == 0 {
        return Ok(());
    }
    sql_query("INSERT OR IGNORE INTO ratings (rating) VALUES (?)")
        .bind::<Integer, _>(rating)
        .execute(conn)?;
    sql_query(
        "INSERT INTO books_ratings_link (book, rating) \
         SELECT ?, id FROM ratings WHERE rating = ? ORDER BY id LIMIT 1",
    )
    .bind::<Integer, _>(book_id.as_i32())
    .bind::<Integer, _>(rating)
    .execute(conn)?;
    Ok(())
}

/// Replaces all of the book's identifiers. Labels are stored lowercase;
/// entries with an empty label or value are skipped.
pub(crate) fn replace_identifiers(
    conn: &mut SqliteConnection,
    book_id: BookId,
    identifiers: &HashMap<String, String>,
) -> Result<(), CalibreError> {
    sql_query("DELETE FROM identifiers WHERE book = ?")
        .bind::<Integer, _>(book_id.as_i32())
        .execute(conn)?;
    let mut entries: Vec<(String, &str)> = identifiers
        .iter()
        .map(|(label, value)| (label.trim().to_lowercase(), value.trim()))
        .filter(|(label, value)| !label.is_empty() && !value.is_empty())
        .collect();
    entries.sort();
    entries.dedup_by(|a, b| a.0 == b.0);
    for (label, value) in entries {
        sql_query("INSERT INTO identifiers (book, type, val) VALUES (?, ?, ?)")
            .bind::<Integer, _>(book_id.as_i32())
            .bind::<Text, _>(label)
            .bind::<Text, _>(value)
            .execute(conn)?;
    }
    Ok(())
}
