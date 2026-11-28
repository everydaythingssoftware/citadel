//! Recognizing a book the library may already hold, before it is added.
//!
//! Matching only identifies possible duplicates; it never stops a book from
//! being added. Two books match when:
//!
//! - their ISBNs are the same book ([`MatchReason::Isbn`]), whatever their
//!   formatting and whether either is an ISBN-10;
//! - otherwise, their titles are the same ignoring case and punctuation, they
//!   share at least one author (ignoring case, punctuation and name order) and
//!   their languages don't clash ([`MatchReason::TitleAndAuthor`]);
//! - otherwise, their titles are the same and one of them has no author
//!   ([`MatchReason::Title`]).
//!
//! The same title by different authors is not a match. Languages clash when
//! both books have languages and none is shared.

use std::collections::BTreeSet;

use crate::{book_file, queries::languages::canonicalize_lang_code, BookId};

/// The name Calibre (and libcalibre) files a book without authors under.
const UNKNOWN_AUTHOR: &str = "unknown";

/// A book about to be added, as matching sees it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Candidate {
    /// The book's title.
    pub title: String,
    /// The book's authors. Blank names and `Unknown` count as no author.
    pub author_names: Vec<String>,
    /// The book's ISBN as written (hyphens, spaces and `urn:isbn:` or
    /// `ISBN:` prefixes allowed). Anything that isn't a valid ISBN is
    /// ignored.
    pub isbn: Option<String>,
    /// The book's languages, as any ISO 639 code (`en`, `eng`, `en-US`).
    pub languages: Vec<String>,
}

/// Why a book in the library may be the same as a candidate, strongest
/// first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MatchReason {
    /// Both have the same ISBN.
    Isbn,
    /// Same title, at least one author in common, no language clash.
    TitleAndAuthor,
    /// Same title, and one of them has no author.
    Title,
}

/// A book in the library that may be the same as a candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DuplicateMatch {
    /// The book in the library.
    pub book_id: BookId,
    /// The strongest reason it matches.
    pub reason: MatchReason,
}

/// Keys that are equal for files of the same book, for grouping the files of
/// one new book (an EPUB and a MOBI, say) before any of them is added.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct MatchKeys {
    /// The ISBN as 13 digits, when the candidate has a valid one.
    pub isbn: Option<String>,
    /// The [`title_key`], `|`, then the candidate's sorted [`author_key`]s
    /// joined by ` & `. `None` when the candidate has no author.
    pub title_authors: Option<String>,
}

/// Titles with the same key are the same title: case, punctuation and
/// spacing don't count, accents do. A title with no letters or digits keys
/// as itself, lowercased and trimmed.
pub fn title_key(title: &str) -> String {
    let lowercase = title.to_lowercase();
    let words: Vec<&str> = lowercase
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    if words.is_empty() {
        return lowercase.trim().to_string();
    }
    words.join(" ")
}

/// Author names with the same key are the same author: case, punctuation and
/// the order of the name's words don't count, so `Zola, Émile` and
/// `Émile Zola` match.
pub fn author_key(name: &str) -> String {
    let lowercase = name.to_lowercase();
    let words: BTreeSet<&str> = lowercase
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .collect();
    words.into_iter().collect::<Vec<_>>().join(" ")
}

/// The ISBN in `identifier` as its 13 digits, or `None` when it isn't a
/// valid ISBN. Hyphens, spaces and `urn:isbn:` or `ISBN:` prefixes are
/// allowed; an ISBN-10 becomes the ISBN-13 for the same book.
pub fn canonical_isbn(identifier: &str) -> Option<String> {
    let isbn = book_file::isbn(identifier)?;
    let digits: Vec<u32> = isbn
        .chars()
        .map(|c| if c == 'X' { Some(10) } else { c.to_digit(10) })
        .collect::<Option<_>>()?;
    match digits.as_slice() {
        [body @ .., check] if digits.len() == 10 => {
            let sum: u32 = body
                .iter()
                .zip((2..=10).rev())
                .map(|(digit, weight)| digit * weight)
                .sum();
            if body.contains(&10) || !(sum + check).is_multiple_of(11) {
                return None;
            }
            let mut isbn13: Vec<u32> = vec![9, 7, 8];
            isbn13.extend_from_slice(body);
            isbn13.push(isbn13_check(&isbn13));
            Some(isbn13.iter().map(u32::to_string).collect())
        }
        [body @ .., check] if digits.len() == 13 => (isbn13_check(body) == *check).then_some(isbn),
        _ => None,
    }
}

fn isbn13_check(body: &[u32]) -> u32 {
    let sum: u32 = body
        .iter()
        .zip([1, 3].iter().cycle())
        .map(|(digit, weight)| digit * weight)
        .sum();
    (10 - sum % 10) % 10
}

/// The keys that group files of the same new book.
pub fn match_keys(candidate: &Candidate) -> MatchKeys {
    let authors = author_keys(&candidate.author_names);
    MatchKeys {
        isbn: candidate.isbn.as_deref().and_then(canonical_isbn),
        title_authors: (!authors.is_empty()).then(|| {
            let authors: Vec<&str> = authors.iter().map(String::as_str).collect();
            format!("{}|{}", title_key(&candidate.title), authors.join(" & "))
        }),
    }
}

/// The distinct author keys of `names`, leaving out blanks and `Unknown`.
fn author_keys(names: &[String]) -> BTreeSet<String> {
    names
        .iter()
        .map(|name| author_key(name))
        .filter(|key| !key.is_empty() && key != UNKNOWN_AUTHOR)
        .collect()
}

/// Canonical language codes, from any ISO 639 form or a language tag.
fn language_codes<'a>(codes: impl IntoIterator<Item = &'a String>) -> BTreeSet<String> {
    codes
        .into_iter()
        .filter_map(|code| code.split(['-', '_']).next())
        .map(canonicalize_lang_code)
        .filter(|code| !code.is_empty())
        .collect()
}

/// A book (candidate or in the library) reduced to what matching compares.
#[derive(Debug)]
pub(crate) struct MatchProfile {
    pub(crate) title: String,
    pub(crate) authors: BTreeSet<String>,
    pub(crate) isbns: BTreeSet<String>,
    pub(crate) languages: BTreeSet<String>,
}

impl MatchProfile {
    pub(crate) fn new(
        title: &str,
        author_names: &[String],
        isbns: impl IntoIterator<Item = String>,
        languages: &[String],
    ) -> Self {
        Self {
            title: title_key(title),
            authors: author_keys(author_names),
            isbns: isbns
                .into_iter()
                .filter_map(|isbn| canonical_isbn(&isbn))
                .collect(),
            languages: language_codes(languages),
        }
    }

    pub(crate) fn of(candidate: &Candidate) -> Self {
        Self::new(
            &candidate.title,
            &candidate.author_names,
            candidate.isbn.clone(),
            &candidate.languages,
        )
    }

    /// Why `self` may be the same book as `other`, if it may.
    pub(crate) fn reason(&self, other: &MatchProfile) -> Option<MatchReason> {
        if !self.isbns.is_disjoint(&other.isbns) {
            return Some(MatchReason::Isbn);
        }
        if self.title != other.title {
            return None;
        }
        let clash = !self.languages.is_empty()
            && !other.languages.is_empty()
            && self.languages.is_disjoint(&other.languages);
        if clash {
            return None;
        }
        if self.authors.is_empty() || other.authors.is_empty() {
            return Some(MatchReason::Title);
        }
        (!self.authors.is_disjoint(&other.authors)).then_some(MatchReason::TitleAndAuthor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(title: &str, authors: &[&str]) -> Candidate {
        Candidate {
            title: title.into(),
            author_names: authors.iter().map(|name| name.to_string()).collect(),
            isbn: None,
            languages: Vec::new(),
        }
    }

    fn reason(left: &Candidate, right: &Candidate) -> Option<MatchReason> {
        MatchProfile::of(left).reason(&MatchProfile::of(right))
    }

    #[test]
    fn titles_ignore_case_and_punctuation_but_not_accents() {
        assert_eq!(title_key("  Contract:  BOOK!"), "contract book");
        assert_eq!(
            title_key("Moby-Dick; or, The Whale"),
            "moby dick or the whale"
        );
        assert_ne!(title_key("Résumé"), title_key("Resume"));
        assert_eq!(title_key(" ? "), "?");
        assert_ne!(title_key("?"), title_key("!"));
    }

    #[test]
    fn author_names_ignore_word_order() {
        assert_eq!(author_key("Zola, Émile"), author_key("Émile Zola"));
        assert_eq!(author_key("ZOLA émile"), "zola émile");
        assert_ne!(author_key("Emile Zola"), author_key("Émile Zola"));
        assert_eq!(author_key(" , "), "");
    }

    #[test]
    fn isbns_are_checked_and_made_thirteen_digits() {
        assert_eq!(
            canonical_isbn("urn:isbn:978-0-306-40615-7").as_deref(),
            Some("9780306406157")
        );
        assert_eq!(
            canonical_isbn("ISBN: 0-306-40615-2").as_deref(),
            Some("9780306406157")
        );
        assert_eq!(
            canonical_isbn("0 14 044913 X").as_deref(),
            None,
            "wrong check digit"
        );
        assert_eq!(
            canonical_isbn("080442957X").as_deref(),
            Some("9780804429573")
        );
        assert_eq!(canonical_isbn("9780306406158"), None);
        assert_eq!(canonical_isbn("0306406153"), None);
        assert_eq!(canonical_isbn("urn:uuid:1234"), None);
        assert_eq!(canonical_isbn(""), None);
    }

    #[test]
    fn the_same_isbn_matches_whatever_the_title() {
        let mut left = candidate("Walden", &["Henry David Thoreau"]);
        let mut right = candidate("Walden; or, Life in the Woods", &["Someone Else"]);
        left.isbn = Some("0-306-40615-2".into());
        right.isbn = Some("9780306406157".into());
        assert_eq!(reason(&left, &right), Some(MatchReason::Isbn));
    }

    #[test]
    fn a_shared_author_and_title_match() {
        let left = candidate("Nana", &["Zola, Émile"]);
        let right = candidate("NANA", &["Émile Zola", "Translator"]);
        assert_eq!(reason(&left, &right), Some(MatchReason::TitleAndAuthor));
    }

    #[test]
    fn the_same_title_by_different_authors_is_not_a_match() {
        let left = candidate("Poems", &["Emily Dickinson"]);
        let right = candidate("Poems", &["Walt Whitman"]);
        assert_eq!(reason(&left, &right), None);
    }

    #[test]
    fn a_title_without_authors_matches_on_its_own() {
        let left = candidate("Beowulf", &[]);
        let right = candidate("beowulf", &["Seamus Heaney"]);
        assert_eq!(reason(&left, &right), Some(MatchReason::Title));
        let unknown = candidate("Beowulf", &["Unknown"]);
        assert_eq!(reason(&unknown, &right), Some(MatchReason::Title));
        assert_eq!(reason(&unknown, &left), Some(MatchReason::Title));
    }

    #[test]
    fn clashing_languages_are_not_a_match() {
        let mut english = candidate("Candide", &["Voltaire"]);
        let mut french = candidate("Candide", &["Voltaire"]);
        english.languages = vec!["en-GB".into()];
        french.languages = vec!["fra".into()];
        assert_eq!(reason(&english, &french), None);
        french.languages = vec!["eng".into()];
        assert_eq!(reason(&english, &french), Some(MatchReason::TitleAndAuthor));
        french.languages.clear();
        assert_eq!(reason(&english, &french), Some(MatchReason::TitleAndAuthor));
    }

    #[test]
    fn match_keys_group_files_of_one_book() {
        let epub = Candidate {
            isbn: Some("urn:isbn:0-306-40615-2".into()),
            ..candidate("The Book!", &["Zola, Émile", "Ann Other"])
        };
        let mobi = candidate("the book", &["Ann Other", "Émile Zola", "unknown"]);
        assert_eq!(
            match_keys(&epub),
            MatchKeys {
                isbn: Some("9780306406157".into()),
                title_authors: Some("the book|ann other & zola émile".into()),
            }
        );
        assert_eq!(
            match_keys(&epub).title_authors,
            match_keys(&mobi).title_authors
        );
        assert_eq!(match_keys(&mobi).isbn, None);
        assert_eq!(
            match_keys(&candidate("Anonymous", &["Unknown"])).title_authors,
            None
        );
    }
}
