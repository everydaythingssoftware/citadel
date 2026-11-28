//! Unicode case folding for the search and the name lookups.
//!
//! Both folds compare in NFC and keep accents, so "garcia" and "García" stay
//! different, the same as in Calibre's default search. Both also fold "ё" to
//! "е", because Russian text often writes "е" in place of "ё".
//!
//! SQLite gets the folds as the SQL functions `casefold` and
//! `casefold_simple`. Only queries may call them: Calibre does not have them,
//! so a trigger, view or index that uses them breaks the library for Calibre.

use diesel::sql_types::{Integer, Text};
use diesel::{sql_query, OptionalExtension, QueryableByName, RunQueryDsl, SqliteConnection};
use icu_casemap::{CaseMapper, CaseMapperBorrowed};
use icu_normalizer::{ComposingNormalizerBorrowed, DecomposingNormalizerBorrowed};

use crate::CalibreError;

const CASE_MAPPER: CaseMapperBorrowed<'static> = CaseMapper::new();
const NFC: ComposingNormalizerBorrowed<'static> = ComposingNormalizerBorrowed::new_nfc();
const NFD: DecomposingNormalizerBorrowed<'static> = DecomposingNormalizerBorrowed::new_nfd();

/// The search fold: the Unicode full case folding, so "Straße" and "STRASSE"
/// match. ASCII text only gets lower case, as SQLite's `LIKE` gives it.
pub(crate) fn fold(text: &str) -> String {
    if text.is_ascii() {
        return text.to_ascii_lowercase();
    }
    compose(&CASE_MAPPER.fold_string(&NFD.normalize(text)))
}

/// The lookup fold for the name lookups: the Unicode simple case folding,
/// which maps each character to one character. Thus "Straße" and "STRASSE"
/// stay different, but "Фэнтези" and "фэнтези" match.
pub(crate) fn fold_simple(text: &str) -> String {
    if text.is_ascii() {
        return text.to_ascii_lowercase();
    }
    let folded: String = NFD
        .normalize(text)
        .chars()
        .map(|c| CASE_MAPPER.simple_fold(c))
        .collect();
    compose(&folded)
}

/// Composes folded text to NFC and replaces "ё" with "е". The replacement
/// repeats, because NFC can compose a new "ё" from "е" and a second
/// diaeresis.
fn compose(folded: &str) -> String {
    let mut text = NFC.normalize(folded).into_owned();
    while text.contains('ё') {
        text = NFC.normalize(&text.replace('ё', "е")).into_owned();
    }
    text
}

#[derive(QueryableByName)]
struct IdRow {
    #[diesel(sql_type = Integer)]
    id: i32,
}

/// The folded step of a name lookup, for a value that the indexed
/// `COLLATE NOCASE` lookup does not find: the lowest id in `table` whose
/// `column` matches `value` by [`fold_simple`]. An ASCII `value` returns
/// `None` at once, because the indexed lookup already applies the ASCII rule.
///
/// `table` and `column` go into the SQL text, so pass only constant names, or
/// `custom_column_{n}` with an integer `n`, never text from a user.
pub(crate) fn find_id_by_folded_value(
    conn: &mut SqliteConnection,
    table: &str,
    column: &str,
    value: &str,
) -> Result<Option<i32>, CalibreError> {
    if value.is_ascii() {
        return Ok(None);
    }
    sql_query(format!(
        "SELECT id FROM {table} WHERE casefold_simple({column}) = ? ORDER BY id LIMIT 1"
    ))
    .bind::<Text, _>(fold_simple(value))
    .get_result::<IdRow>(conn)
    .optional()
    .map(|row| row.map(|row| row.id))
    .map_err(CalibreError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use icu_normalizer::ComposingNormalizerBorrowed;
    use proptest::prelude::*;

    #[test]
    fn fold_lowercases_ascii() {
        assert_eq!(fold("Hello WORLD"), "hello world");
        assert_eq!(fold_simple("Hello WORLD"), "hello world");
    }

    #[test]
    fn fold_folds_cyrillic_case() {
        assert_eq!(fold("Толстой"), "толстой");
        assert_eq!(fold("ОДИССЕЯ"), "одиссея");
        assert_eq!(fold_simple("Толстой"), "толстой");
        assert_eq!(fold_simple("ОДИССЕЯ"), "одиссея");
    }

    #[test]
    fn fold_folds_greek_final_sigma() {
        assert_eq!(fold("Οδυσσεύς"), "οδυσσεύσ");
        assert_eq!(fold_simple("Οδυσσεύς"), "οδυσσεύσ");
    }

    #[test]
    fn fold_maps_yo_to_ye() {
        assert_eq!(fold("Всё"), "все");
        assert_eq!(fold_simple("Всё"), "все");
        assert_eq!(fold("Ёжик"), fold("ежик"));
        assert_eq!(fold_simple("Ёжик"), fold_simple("ежик"));
    }

    #[test]
    fn fold_keeps_accents() {
        assert_eq!(fold("García"), "garcía");
        assert_eq!(fold_simple("García"), "garcía");
        assert_ne!(fold("García"), fold("garcia"));
    }

    #[test]
    fn fold_composes_a_decomposed_accent() {
        assert_eq!(fold("e\u{0301}"), "\u{00E9}");
        assert_eq!(fold_simple("e\u{0301}"), "\u{00E9}");
    }

    #[test]
    fn fold_expands_sharp_s_but_fold_simple_keeps_it() {
        assert_eq!(fold("Straße"), "strasse");
        assert_eq!(fold_simple("Straße"), "straße");
    }

    #[test]
    fn fold_expands_a_ligature_but_fold_simple_keeps_it() {
        assert_eq!(fold("\u{FB01}ction"), "fiction");
        assert_eq!(fold_simple("\u{FB01}ction"), "\u{FB01}ction");
    }

    #[test]
    fn fold_uses_the_default_dotted_i_folding() {
        assert_eq!(fold("İstanbul"), "i\u{0307}stanbul");
        assert_eq!(fold_simple("İstanbul"), "i\u{0307}stanbul");
    }

    const MIXED_TEXT: &str = "[a-zA-ZА-яЁёΑ-ωςßẞﬁİı\u{0300}-\u{036F} ]{0,24}";

    fn is_nfc(text: &str) -> bool {
        ComposingNormalizerBorrowed::new_nfc().is_normalized(text)
    }

    proptest! {
        #[test]
        fn fold_is_idempotent(text in any::<String>()) {
            prop_assert_eq!(fold(&fold(&text)), fold(&text));
            prop_assert_eq!(fold_simple(&fold_simple(&text)), fold_simple(&text));
        }

        #[test]
        fn fold_is_idempotent_on_mixed_text(text in MIXED_TEXT) {
            prop_assert_eq!(fold(&fold(&text)), fold(&text));
            prop_assert_eq!(fold_simple(&fold_simple(&text)), fold_simple(&text));
        }

        #[test]
        fn fold_gives_nfc(text in any::<String>()) {
            prop_assert!(is_nfc(&fold(&text)));
            prop_assert!(is_nfc(&fold_simple(&text)));
        }

        #[test]
        fn fold_gives_nfc_on_mixed_text(text in MIXED_TEXT) {
            prop_assert!(is_nfc(&fold(&text)));
            prop_assert!(is_nfc(&fold_simple(&text)));
        }

        #[test]
        fn fold_of_ascii_is_ascii_lowercase(text in "[ -~]{0,24}") {
            prop_assert_eq!(fold(&text), text.to_ascii_lowercase());
            prop_assert_eq!(fold_simple(&text), text.to_ascii_lowercase());
        }

        #[test]
        fn fold_simple_match_is_a_fold_match(text in any::<String>()) {
            prop_assert_eq!(fold(&fold_simple(&text)), fold(&text));
        }

        #[test]
        fn fold_simple_match_is_a_fold_match_on_mixed_text(text in MIXED_TEXT) {
            prop_assert_eq!(fold(&fold_simple(&text)), fold(&text));
        }
    }
}
