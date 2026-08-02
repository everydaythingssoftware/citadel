use std::collections::HashMap;

use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{BigInt, Integer, Text};
use diesel::{QueryDsl, RunQueryDsl, SqliteConnection};

use crate::entities::tag::NewTag;
use crate::library::TagSummary;
use crate::types::BookId;
use crate::{CalibreError, Tag};

/// Every tag in the library, sorted case-insensitively by name (with the
/// raw name as a stable tiebreak, matching [`find_for_book`]).
pub(crate) fn list_all(conn: &mut SqliteConnection) -> Result<Vec<TagSummary>, CalibreError> {
    #[derive(QueryableByName)]
    struct TagCountRow {
        #[diesel(sql_type = Integer)]
        id: i32,
        #[diesel(sql_type = Text)]
        name: String,
        #[diesel(sql_type = BigInt)]
        book_count: i64,
    }

    let rows: Vec<TagCountRow> = sql_query(
        "SELECT t.id AS id, t.name AS name, COUNT(btl.book) AS book_count
         FROM tags t
         LEFT JOIN books_tags_link btl ON btl.tag = t.id
         GROUP BY t.id, t.name
         ORDER BY t.name COLLATE NOCASE, t.name, t.id",
    )
    .load(conn)
    .map_err(CalibreError::from)?;

    Ok(rows
        .into_iter()
        .map(|row| TagSummary {
            id: row.id,
            name: row.name,
            book_count: row.book_count,
        })
        .collect())
}

pub(crate) fn find_by_name_case_insensitive(
    conn: &mut SqliteConnection,
    tag_name: &str,
) -> Result<Option<Tag>, CalibreError> {
    sql_query("SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE LIMIT 1")
        .bind::<Text, _>(tag_name)
        .get_result(conn)
        .optional()
        .map_err(CalibreError::from)
}

pub(crate) fn create(conn: &mut SqliteConnection, new_tag: NewTag) -> Result<Tag, CalibreError> {
    use crate::schema::tags::dsl::*;

    diesel::insert_into(tags)
        .values(new_tag)
        .returning(Tag::as_returning())
        .get_result(conn)
        .map_err(CalibreError::from)
}

pub(crate) fn create_if_not_exists(
    conn: &mut SqliteConnection,
    tag_name: &str,
) -> Result<Tag, CalibreError> {
    match find_by_name_case_insensitive(conn, tag_name)? {
        Some(existing) => Ok(existing),
        None => create(
            conn,
            NewTag {
                name: tag_name.to_string(),
            },
        ),
    }
}

pub(crate) fn find_for_book(
    conn: &mut SqliteConnection,
    book_id: BookId,
) -> Result<Vec<Tag>, CalibreError> {
    use crate::schema::{books_tags_link, tags};

    tags::table
        .inner_join(books_tags_link::table.on(books_tags_link::tag.eq(tags::id)))
        .filter(books_tags_link::book.eq(book_id.as_i32()))
        .select(Tag::as_select())
        .order_by(diesel::dsl::sql::<Text>("LOWER(tags.name), tags.name"))
        .load(conn)
        .map_err(CalibreError::from)
}

pub(crate) fn link_book(
    conn: &mut SqliteConnection,
    tag_id: i32,
    book_id: BookId,
) -> Result<(), CalibreError> {
    use crate::schema::books_tags_link::dsl::*;

    diesel::insert_into(books_tags_link)
        .values((tag.eq(tag_id), book.eq(book_id.as_i32())))
        .execute(conn)
        .map_err(CalibreError::from)?;

    Ok(())
}

pub(crate) fn unlink_book(
    conn: &mut SqliteConnection,
    tag_id_value: i32,
    book_id: BookId,
) -> Result<(), CalibreError> {
    use crate::schema::books_tags_link::dsl::*;

    diesel::delete(
        books_tags_link
            .filter(tag.eq(tag_id_value))
            .filter(book.eq(book_id.as_i32())),
    )
    .execute(conn)
    .map_err(CalibreError::from)?;

    Ok(())
}

pub(crate) fn find_tag_names_by_book_ids(
    conn: &mut SqliteConnection,
    book_ids: Vec<BookId>,
) -> Result<HashMap<BookId, Vec<String>>, CalibreError> {
    if book_ids.is_empty() {
        return Ok(HashMap::new());
    }

    #[derive(QueryableByName)]
    struct BookTagName {
        #[diesel(sql_type = Integer)]
        book_id: i32,
        #[diesel(sql_type = Text)]
        tag_name: String,
    }

    let ids = book_ids
        .iter()
        .map(|book_id| book_id.as_i32().to_string())
        .collect::<Vec<_>>()
        .join(",");

    let rows: Vec<BookTagName> = sql_query(format!(
        "SELECT btl.book AS book_id, t.name AS tag_name
         FROM books_tags_link btl
         INNER JOIN tags t ON t.id = btl.tag
         WHERE btl.book IN ({ids})
         ORDER BY LOWER(t.name), t.name"
    ))
    .load(conn)
    .map_err(CalibreError::from)?;

    let mut grouped = HashMap::new();
    for row in rows {
        grouped
            .entry(BookId(row.book_id))
            .or_insert_with(Vec::new)
            .push(row.tag_name);
    }

    Ok(grouped)
}
