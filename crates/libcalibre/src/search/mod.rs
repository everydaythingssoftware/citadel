//! The search language of the book query: a subset of the Calibre search
//! language.

mod lexer;
mod parser;
mod sql;

use crate::queries::books::SqlFragment;

/// The most terms that a search can hold.
pub(crate) const MAX_TERMS: usize = 100;

/// The most levels of parentheses and `not` that a search can hold. Before
/// version 3.46, the SQLite parser has a stack of 100 entries, and the SQL of
/// a search with 25 levels overflows it. macOS and Debian 12 ship such a
/// version.
pub(crate) const MAX_DEPTH: usize = 16;

/// The most bytes that a search text can hold, after the trim. With an
/// escape on each character, a LIKE pattern then stays below the limit of
/// 50,000 bytes that SQLite puts on a pattern.
pub(crate) const MAX_TEXT_BYTES: usize = 20_000;

/// The SQL of a search text, with the hints about the text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CompiledSearch {
    /// The `WHERE` condition on the outer table `books`, with its binds.
    pub(crate) fragment: SqlFragment,
    /// The notes about the text. A hint does not stop the query.
    pub(crate) hints: Vec<Spanned<SearchHint>>,
}

/// Compile a search text to SQL.
///
/// Returns `Ok(None)` when the text is blank. The scope selects the fields
/// that a bare word searches. The ranges of the errors and the hints count
/// from the start of `text`, before the trim.
pub(crate) fn compile(
    text: &str,
    scope: SearchScope,
) -> Result<Option<CompiledSearch>, Spanned<SearchError>> {
    let trimmed = text.trim();
    if trimmed.len() > MAX_TEXT_BYTES {
        let start = text.len() - text.trim_start().len();
        return Err(Spanned {
            value: SearchError::TooLong,
            span: start..start + trimmed.len(),
        });
    }
    let Some(parsed) = parser::parse(text)? else {
        return Ok(None);
    };
    Ok(Some(CompiledSearch {
        fragment: sql::to_sql(&parsed.expr, scope),
        hints: parsed.hints,
    }))
}

/// The fields that a bare word searches. A field prefix works the same in
/// each scope.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum SearchScope {
    /// The title, the author names and the series name.
    #[default]
    TitlesAuthorsSeries,
    /// The title, the author names, the series name, the tags, the publisher
    /// and the identifier values.
    AllFields,
}

/// An operator word of the search language.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum SearchOperator {
    /// `and`: each operand matches.
    And,
    /// `or`: one or more operands match.
    Or,
    /// `not`: the operand does not match.
    Not,
}

impl SearchOperator {
    /// The three operators.
    pub(crate) const ALL: [SearchOperator; 3] =
        [SearchOperator::And, SearchOperator::Or, SearchOperator::Not];

    /// The operator word, in lower case.
    pub(crate) fn word(self) -> &'static str {
        match self {
            SearchOperator::And => "and",
            SearchOperator::Or => "or",
            SearchOperator::Not => "not",
        }
    }
}

impl std::fmt::Display for SearchOperator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.word())
    }
}

/// A kind of search that the language names but does not support yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum SearchKind {
    /// A regular expression search (`~`).
    RegularExpression,
    /// A character variant search (`^`).
    CharacterVariant,
    /// A hierarchy search (`=.` and `=..`).
    Hierarchy,
    /// A count search (`#` before `=`, `!`, `<` or `>`).
    Count,
}

/// A reason why a search text does not run.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum SearchError {
    /// A quoted phrase has no closing quote.
    #[error("Missing closing quote.")]
    MissingClosingQuote,
    /// A group has no closing parenthesis.
    #[error("Missing closing parenthesis.")]
    MissingClosingParenthesis,
    /// A closing parenthesis has no opening parenthesis.
    #[error("Unexpected closing parenthesis.")]
    UnexpectedClosingParenthesis,
    /// A group has no content.
    #[error("Empty parentheses.")]
    EmptyGroup,
    /// A quoted phrase has no content.
    #[error("Empty quotes.")]
    EmptyPhrase,
    /// An operator has no term where it needs one.
    #[error("{}", missing_term_message(*.operator))]
    MissingTerm {
        /// The operator that has no term.
        operator: SearchOperator,
    },
    /// A field prefix has no value.
    #[error("Type a value after \"{prefix}:\".")]
    MissingValue {
        /// The text before the colon of the value, as the user typed it. For
        /// an identifiers term, it holds the type part too.
        prefix: String,
    },
    /// An identifiers term has an `=` and no identifier type before its
    /// colon.
    #[error("Type an identifier type after \"{name}:=\".")]
    MissingIdentifierType {
        /// The field name, as the user typed it.
        name: String,
    },
    /// The Calibre search language has the field, but libcalibre cannot
    /// search it yet.
    #[error("Search by \"{name}\" is not supported yet.")]
    UnsupportedField {
        /// The field name, as the user typed it.
        name: String,
    },
    /// The value starts with a character that selects a search kind that is
    /// not supported.
    #[error("{}", unsupported_kind_message(.0))]
    UnsupportedSearchKind(SearchKind),
    /// The search has more than 100 terms.
    #[error("The search has more than {} terms.", MAX_TERMS)]
    TooManyTerms,
    /// The search has more than 16 levels of parentheses and `not`.
    #[error(
        "The search has more than {} levels of parentheses and \"not\".",
        MAX_DEPTH
    )]
    TooDeep,
    /// The search text has more than 20,000 bytes, or more tokens than the
    /// lexer accepts.
    #[error("The search is too long.")]
    TooLong,
}

/// A note about a search that runs. A hint does not stop the query.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum SearchHint {
    /// A word has a prefix that is not a field name. The search treats the
    /// word as text.
    UnknownField {
        /// The prefix, as the user typed it.
        name: String,
    },
}

impl std::fmt::Display for SearchHint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SearchHint::UnknownField { name } => {
                write!(f, "No field named \"{name}\". Searched as text.")
            }
        }
    }
}

/// A search error or hint, with the byte range of the search text that it
/// is about. The message is the message of the value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spanned<T> {
    /// The error or the hint.
    pub value: T,
    /// The byte range in the search text, as the caller gave the text.
    pub span: std::ops::Range<usize>,
}

impl<T: std::fmt::Display> std::fmt::Display for Spanned<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.value.fmt(f)
    }
}

/// Select the message of `MissingTerm` from the operator. The message also
/// tells the user how to search for the word, because a pasted title can
/// hold an operator word.
fn missing_term_message(operator: SearchOperator) -> String {
    let problem = match operator {
        SearchOperator::Not => format!("\"{operator}\" needs a search term after it."),
        SearchOperator::And | SearchOperator::Or => {
            format!("\"{operator}\" needs a search term on each side.")
        }
    };
    format!("{problem} To search for the word, put it in quotes.")
}

/// Select the message of `UnsupportedSearchKind` from the kind.
fn unsupported_kind_message(kind: &SearchKind) -> &'static str {
    match kind {
        SearchKind::RegularExpression => "Regular expression searches (~) are not supported yet.",
        SearchKind::CharacterVariant => "Character variant searches (^) are not supported yet.",
        SearchKind::Hierarchy => "Hierarchy searches (=. and =..) are not supported yet.",
        SearchKind::Count => "Count searches (#) are not supported yet.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_match_the_spec() {
        let cases: Vec<(SearchError, &str)> = vec![
            (SearchError::MissingClosingQuote, "Missing closing quote."),
            (
                SearchError::MissingClosingParenthesis,
                "Missing closing parenthesis.",
            ),
            (
                SearchError::UnexpectedClosingParenthesis,
                "Unexpected closing parenthesis.",
            ),
            (SearchError::EmptyGroup, "Empty parentheses."),
            (SearchError::EmptyPhrase, "Empty quotes."),
            (
                SearchError::MissingTerm {
                    operator: SearchOperator::Not,
                },
                r#""not" needs a search term after it. To search for the word, put it in quotes."#,
            ),
            (
                SearchError::MissingTerm {
                    operator: SearchOperator::Or,
                },
                r#""or" needs a search term on each side. To search for the word, put it in quotes."#,
            ),
            (
                SearchError::MissingTerm {
                    operator: SearchOperator::And,
                },
                r#""and" needs a search term on each side. To search for the word, put it in quotes."#,
            ),
            (
                SearchError::MissingValue {
                    prefix: "tags".into(),
                },
                r#"Type a value after "tags:"."#,
            ),
            (
                SearchError::MissingIdentifierType {
                    name: "identifiers".into(),
                },
                r#"Type an identifier type after "identifiers:="."#,
            ),
            (
                SearchError::UnsupportedField {
                    name: "rating".into(),
                },
                r#"Search by "rating" is not supported yet."#,
            ),
            (
                SearchError::UnsupportedSearchKind(SearchKind::RegularExpression),
                "Regular expression searches (~) are not supported yet.",
            ),
            (
                SearchError::UnsupportedSearchKind(SearchKind::CharacterVariant),
                "Character variant searches (^) are not supported yet.",
            ),
            (
                SearchError::UnsupportedSearchKind(SearchKind::Hierarchy),
                "Hierarchy searches (=. and =..) are not supported yet.",
            ),
            (
                SearchError::UnsupportedSearchKind(SearchKind::Count),
                "Count searches (#) are not supported yet.",
            ),
            (
                SearchError::TooManyTerms,
                "The search has more than 100 terms.",
            ),
            (
                SearchError::TooDeep,
                r#"The search has more than 16 levels of parentheses and "not"."#,
            ),
            (SearchError::TooLong, "The search is too long."),
        ];
        for (error, message) in cases {
            assert_eq!(error.to_string(), message);
        }
        assert_eq!(
            SearchHint::UnknownField {
                name: "titel".into()
            }
            .to_string(),
            r#"No field named "titel". Searched as text."#
        );
    }

    #[test]
    fn a_text_longer_than_the_byte_limit_is_too_long() {
        let scope = SearchScope::TitlesAuthorsSeries;
        let too_long = |text: &str| {
            compile(text, scope)
                .map(|_| ())
                .map_err(|e| (e.value, e.span))
        };
        assert!(compile(&"a".repeat(MAX_TEXT_BYTES), scope).is_ok());
        assert_eq!(
            too_long(&"a".repeat(MAX_TEXT_BYTES + 1)),
            Err((SearchError::TooLong, 0..MAX_TEXT_BYTES + 1))
        );
        assert!(
            compile(&format!("  {}  ", "a".repeat(MAX_TEXT_BYTES)), scope).is_ok(),
            "the limit applies after the trim"
        );
        assert_eq!(
            too_long(&format!("  {}  ", "a".repeat(MAX_TEXT_BYTES + 1))),
            Err((SearchError::TooLong, 2..MAX_TEXT_BYTES + 3)),
            "the range covers the trimmed text"
        );
        assert_eq!(
            too_long(&"é".repeat(MAX_TEXT_BYTES / 2 + 1)),
            Err((SearchError::TooLong, 0..MAX_TEXT_BYTES + 2)),
            "the limit counts bytes, not characters"
        );
    }

    #[test]
    fn ranges_count_from_the_start_of_the_untrimmed_text() {
        let compiled = compile("  dune titel:x", SearchScope::TitlesAuthorsSeries)
            .unwrap()
            .unwrap();
        assert_eq!(compiled.hints[0].span, 7..14);
        assert_eq!(
            compile("  x and", SearchScope::TitlesAuthorsSeries).map(|_| ()),
            Err(Spanned {
                value: SearchError::MissingTerm {
                    operator: SearchOperator::And
                },
                span: 4..7
            })
        );
    }
}
