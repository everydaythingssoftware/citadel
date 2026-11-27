use std::collections::HashMap;

use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{Integer, Text};
use diesel::{QueryDsl, RunQueryDsl, SqliteConnection};

use crate::entities::language::{Language, NewLanguage};
use crate::types::BookId;
use crate::CalibreError;

/// Normalize a language code to the form Calibre stores in the `languages`
/// table: lowercase ISO 639-2/3 (three letters), e.g. `eng`, `fra`, `spa`.
/// Two-letter ISO 639-1 codes (`en`, `fr`) — what EPUB/OPF metadata usually
/// carries — are mapped to their three-letter equivalent. Anything already
/// three letters (or unrecognized) is passed through lowercased/trimmed.
pub fn canonicalize_lang_code(code: &str) -> String {
    let normalized = code.trim().to_lowercase();

    let mapped = match normalized.as_str() {
        "en" => "eng",
        "fr" => "fra",
        "es" => "spa",
        "de" => "deu",
        "it" => "ita",
        "pt" => "por",
        "nl" => "nld",
        "ru" => "rus",
        "pl" => "pol",
        "sv" => "swe",
        "no" => "nor",
        "da" => "dan",
        "fi" => "fin",
        "cs" => "ces",
        "el" => "ell",
        "tr" => "tur",
        "ar" => "ara",
        "he" => "heb",
        "hi" => "hin",
        "ja" => "jpn",
        "ko" => "kor",
        "zh" => "zho",
        "uk" => "ukr",
        "ro" => "ron",
        "hu" => "hun",
        "la" => "lat",
        other => other,
    };

    mapped.to_string()
}

fn find_by_code_case_insensitive(
    conn: &mut SqliteConnection,
    code: &str,
) -> Result<Option<Language>, CalibreError> {
    sql_query("SELECT id, lang_code FROM languages WHERE lang_code = ? COLLATE NOCASE LIMIT 1")
        .bind::<Text, _>(code)
        .get_result(conn)
        .optional()
        .map_err(CalibreError::from)
}

fn create(
    conn: &mut SqliteConnection,
    new_language: NewLanguage,
) -> Result<Language, CalibreError> {
    use crate::schema::languages::dsl::*;

    diesel::insert_into(languages)
        .values(new_language)
        .returning(Language::as_returning())
        .get_result(conn)
        .map_err(CalibreError::from)
}

/// Find the `languages` row for `code` (canonicalized), creating it if absent.
fn create_if_not_exists(conn: &mut SqliteConnection, code: &str) -> Result<Language, CalibreError> {
    let canonical = canonicalize_lang_code(code);
    match find_by_code_case_insensitive(conn, &canonical)? {
        Some(existing) => Ok(existing),
        None => create(
            conn,
            NewLanguage {
                lang_code: canonical,
            },
        ),
    }
}

/// The book's language codes, ordered by `item_order` (Calibre's display
/// order). Empty when the book has no language links.
pub(crate) fn find_codes_for_book(
    conn: &mut SqliteConnection,
    book_id: BookId,
) -> Result<Vec<String>, CalibreError> {
    #[derive(QueryableByName)]
    struct LangCode {
        #[diesel(sql_type = Text)]
        lang_code: String,
    }

    let rows: Vec<LangCode> = sql_query(
        "SELECT l.lang_code AS lang_code
         FROM books_languages_link bll
         INNER JOIN languages l ON l.id = bll.lang_code
         WHERE bll.book = ?
         ORDER BY bll.item_order",
    )
    .bind::<Integer, _>(book_id.as_i32())
    .load(conn)
    .map_err(CalibreError::from)?;

    Ok(rows.into_iter().map(|row| row.lang_code).collect())
}

/// Language codes for many books at once, each ordered by `item_order`. Books
/// with no language links are absent from the map.
pub(crate) fn find_codes_by_book_ids(
    conn: &mut SqliteConnection,
    book_ids: Vec<BookId>,
) -> Result<HashMap<BookId, Vec<String>>, CalibreError> {
    if book_ids.is_empty() {
        return Ok(HashMap::new());
    }

    #[derive(QueryableByName)]
    struct BookLangCode {
        #[diesel(sql_type = Integer)]
        book_id: i32,
        #[diesel(sql_type = Text)]
        lang_code: String,
    }

    let ids = book_ids
        .iter()
        .map(|book_id| book_id.as_i32().to_string())
        .collect::<Vec<_>>()
        .join(",");

    let rows: Vec<BookLangCode> = sql_query(format!(
        "SELECT bll.book AS book_id, l.lang_code AS lang_code
         FROM books_languages_link bll
         INNER JOIN languages l ON l.id = bll.lang_code
         WHERE bll.book IN ({ids})
         ORDER BY bll.book, bll.item_order"
    ))
    .load(conn)
    .map_err(CalibreError::from)?;

    let mut grouped: HashMap<BookId, Vec<String>> = HashMap::new();
    for row in rows {
        grouped
            .entry(BookId(row.book_id))
            .or_default()
            .push(row.lang_code);
    }

    Ok(grouped)
}

/// Replace the book's language links with `codes` (canonicalized, deduped,
/// order preserved). An empty slice clears all of the book's language links.
pub(crate) fn set_for_book(
    conn: &mut SqliteConnection,
    book_id: BookId,
    codes: &[String],
) -> Result<(), CalibreError> {
    use crate::schema::books_languages_link::dsl as link;

    diesel::delete(link::books_languages_link.filter(link::book.eq(book_id.as_i32())))
        .execute(conn)?;

    let mut seen: Vec<String> = Vec::new();
    let mut order: i32 = 0;
    for code in codes {
        let canonical = canonicalize_lang_code(code);
        if canonical.is_empty() || seen.iter().any(|c| c == &canonical) {
            continue;
        }
        let language = create_if_not_exists(conn, &canonical)?;
        diesel::insert_into(link::books_languages_link)
            .values((
                link::book.eq(book_id.as_i32()),
                link::lang_code.eq(language.id),
                link::item_order.eq(order),
            ))
            .execute(conn)?;
        seen.push(canonical);
        order += 1;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_iso_639_1_to_639_3() {
        assert_eq!(canonicalize_lang_code("en"), "eng");
        assert_eq!(canonicalize_lang_code("FR"), "fra");
        assert_eq!(canonicalize_lang_code("  es  "), "spa");
    }

    #[test]
    fn passes_through_three_letter_and_unknown_codes() {
        assert_eq!(canonicalize_lang_code("eng"), "eng");
        assert_eq!(canonicalize_lang_code("FRA"), "fra");
        assert_eq!(canonicalize_lang_code("xyz"), "xyz");
    }
}
