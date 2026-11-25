//! The parser of the search language: it changes tokens into a search
//! expression.

use chumsky::error::{Error, LabelError};
use chumsky::extra;
use chumsky::input::{MapExtra, MappedInput};
use chumsky::inspector::SimpleState;
use chumsky::prelude::*;
use chumsky::util::MaybeRef;

use super::lexer::{tokenize, Piece, Token};
use super::{SearchError, SearchHint, SearchKind, SearchOperator, Spanned, MAX_DEPTH, MAX_TERMS};

/// A book field that a term can search.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Field {
    /// The title of the book.
    Title,
    /// The names of the authors.
    Authors,
    /// The name of the series.
    Series,
    /// The names of the tags.
    Tags,
    /// The name of the publisher.
    Publisher,
    /// The text of the comments.
    Comments,
    /// The identifiers of the book.
    Identifiers,
    /// The formats of the book.
    Formats,
    /// The language codes of the book.
    Languages,
}

/// A text comparison.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TextMatch {
    /// The value contains the text.
    Contains(String),
    /// The value equals the text.
    Equals(String),
}

/// A condition on the value of a field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Matcher {
    /// The value matches a text.
    Text(TextMatch),
    /// The book has a value.
    Present,
    /// The book has no value.
    Absent,
}

/// One search term.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Term {
    /// A bare word or a quoted phrase. It searches the bare-word fields of
    /// the scope.
    Bare(TextMatch),
    /// A condition on one field.
    Field {
        /// The field.
        field: Field,
        /// The condition.
        matcher: Matcher,
    },
    /// A condition on the identifiers of the book.
    Identifier {
        /// The condition on the type, or `None` for any type.
        kind: Option<TextMatch>,
        /// The condition on the value.
        value: Matcher,
    },
}

/// A search expression. [`Expr::all`] and [`Expr::any`] make each `And`
/// and `Or`, so that its list is flat and has two or more operands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Expr {
    /// All operands match.
    And(Vec<Expr>),
    /// One or more operands match.
    Or(Vec<Expr>),
    /// The operand does not match.
    Not(Box<Expr>),
    /// One term.
    Term(Term),
}

impl Expr {
    /// Make an `And` of `first` and `rest`. One operand stays alone.
    fn all(first: Expr, rest: Vec<Expr>) -> Expr {
        group(first, rest, true)
    }

    /// Make an `Or` of `first` and `rest`. One operand stays alone.
    fn any(first: Expr, rest: Vec<Expr>) -> Expr {
        group(first, rest, false)
    }
}

/// Make an `And` (`is_and`) or an `Or` of `first` and `rest`. A child of the
/// same kind adds its operands to the list, and one operand stays alone.
fn group(first: Expr, rest: Vec<Expr>, is_and: bool) -> Expr {
    let mut operands = Vec::with_capacity(rest.len() + 1);
    for operand in std::iter::once(first).chain(rest) {
        match operand {
            Expr::And(children) if is_and => operands.extend(children),
            Expr::Or(children) if !is_and => operands.extend(children),
            other => operands.push(other),
        }
    }
    if operands.len() == 1 {
        operands.remove(0)
    } else if is_and {
        Expr::And(operands)
    } else {
        Expr::Or(operands)
    }
}

/// The result of a parse.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Parsed {
    /// The search expression.
    pub(crate) expr: Expr,
    /// The notes about the text. A hint does not stop the query.
    pub(crate) hints: Vec<Spanned<SearchHint>>,
}

/// What a supported field name searches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
    /// One field of the book.
    Field(Field),
    /// The identifiers of one type. `isbn:VALUE` is the short form of
    /// `identifiers:=isbn:VALUE`.
    IdentifierType(&'static str),
}

/// The field names and aliases, with the short form `isbn`. The parser
/// compares them in lower case.
const FIELD_NAMES: &[(&str, Target)] = &[
    ("title", Target::Field(Field::Title)),
    ("authors", Target::Field(Field::Authors)),
    ("author", Target::Field(Field::Authors)),
    ("series", Target::Field(Field::Series)),
    ("tags", Target::Field(Field::Tags)),
    ("tag", Target::Field(Field::Tags)),
    ("publisher", Target::Field(Field::Publisher)),
    ("comments", Target::Field(Field::Comments)),
    ("comment", Target::Field(Field::Comments)),
    ("identifiers", Target::Field(Field::Identifiers)),
    ("identifier", Target::Field(Field::Identifiers)),
    ("formats", Target::Field(Field::Formats)),
    ("format", Target::Field(Field::Formats)),
    ("languages", Target::Field(Field::Languages)),
    ("language", Target::Field(Field::Languages)),
    ("isbn", Target::IdentifierType("isbn")),
];

/// The Calibre fields that this language names but cannot search.
const UNSUPPORTED_FIELDS: &[&str] = &[
    "all",
    "author_sort",
    "cover",
    "date",
    "id",
    "in_tag_browser",
    "last_modified",
    "marked",
    "ondevice",
    "pubdate",
    "rating",
    "search",
    "series_index",
    "series_sort",
    "size",
    "template",
    "timestamp",
    "title_sort",
    "uuid",
    "vl",
];

/// Make a piece that no backslash escapes.
const fn plain(ch: char) -> Piece {
    Piece { ch, escaped: false }
}

/// An unescaped `=`.
const EQUALS: Piece = plain('=');
/// An unescaped `~`.
const TILDE: Piece = plain('~');
/// An unescaped `^`.
const CARET: Piece = plain('^');
/// An unescaped `.`.
const DOT: Piece = plain('.');
/// An unescaped `#`.
const HASH: Piece = plain('#');
/// An unescaped `:`.
const COLON: Piece = plain(':');

/// Join the characters of some pieces.
fn text_of(pieces: &[Piece]) -> String {
    pieces.iter().map(|piece| piece.ch).collect()
}

/// Find the first colon that no backslash escapes, from the index `start`.
fn find_colon(pieces: &[Piece], start: usize) -> Option<usize> {
    pieces
        .iter()
        .skip(start)
        .position(|p| p.ch == ':' && !p.escaped)
        .map(|index| index + start)
}

/// The target of a field name, an alias or `isbn`, if `name` is one. `name`
/// must be in lower case.
fn target_of(name: &str) -> Option<Target> {
    FIELD_NAMES
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, target)| *target)
}

/// Read the text comparison of a value. The first character selects the
/// kind. A lone `=` has no text to compare, so it is the text `=`.
fn text_match(pieces: &[Piece]) -> Result<TextMatch, SearchError> {
    match pieces {
        [TILDE, ..] => Err(SearchError::UnsupportedSearchKind(
            SearchKind::RegularExpression,
        )),
        [CARET, ..] => Err(SearchError::UnsupportedSearchKind(
            SearchKind::CharacterVariant,
        )),
        [EQUALS, DOT, ..] => Err(SearchError::UnsupportedSearchKind(SearchKind::Hierarchy)),
        [EQUALS, rest @ ..] if !rest.is_empty() => Ok(TextMatch::Equals(text_of(rest))),
        [HASH, Piece {
            ch: '=' | '!' | '<' | '>',
            escaped: false,
        }, ..] => Err(SearchError::UnsupportedSearchKind(SearchKind::Count)),
        _ => Ok(TextMatch::Contains(text_of(pieces))),
    }
}

/// Read the condition of a field value: presence, absence or a text
/// comparison. `prefix` is the text before the value, for an error. A value
/// that is empty or only `=` gives `MissingValue`.
fn matcher(pieces: &[Piece], prefix: &str) -> Result<Matcher, SearchError> {
    if let [] | [EQUALS] = pieces {
        return Err(SearchError::MissingValue {
            prefix: prefix.to_string(),
        });
    }
    if pieces.iter().all(|piece| !piece.escaped) {
        let text = text_of(pieces);
        if text.eq_ignore_ascii_case("true") {
            return Ok(Matcher::Present);
        }
        if text.eq_ignore_ascii_case("false") {
            return Ok(Matcher::Absent);
        }
    }
    Ok(Matcher::Text(text_match(pieces)?))
}

/// Read the value of an `identifiers:` term. The first unescaped colon
/// divides the type and the value. An empty value after the colon means any
/// value. An error about the value names the type part too.
fn identifier(pieces: &[Piece], field: &str) -> Result<Term, SearchError> {
    let Some(index) = find_colon(pieces, 0) else {
        return Ok(Term::Identifier {
            kind: None,
            value: matcher(pieces, field)?,
        });
    };
    let type_part = &pieces[..index];
    let rest = &pieces[index + 1..];
    let value = if rest.is_empty() {
        Matcher::Present
    } else {
        matcher(rest, &format!("{field}:{}", text_of(type_part)))?
    };
    let kind = match type_part {
        [] => None,
        [EQUALS] => {
            return Err(SearchError::MissingIdentifierType {
                name: field.to_string(),
            })
        }
        _ => Some(text_match(type_part)?),
    };
    Ok(Term::Identifier { kind, value })
}

/// True when `name` is a Calibre custom column: `#` and an ASCII letter.
fn is_custom_column(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next() == Some('#') && chars.next().is_some_and(|ch| ch.is_ascii_alphabetic())
}

/// The shortest name that [`is_near_field_name`] compares with. A shorter
/// name, such as the alias `tag`, is one edit from many words, for example
/// `tao` and `tab`.
const MIN_NEAR_NAME_CHARS: usize = 4;

/// True when `name` is one edit from a field name, an alias or `isbn` of
/// [`MIN_NEAR_NAME_CHARS`] or more characters. `name` must be in lower case.
/// An edit adds, removes or changes one character, or swaps two adjacent
/// characters.
fn is_near_field_name(name: &str) -> bool {
    let name: Vec<char> = name.chars().collect();
    FIELD_NAMES
        .iter()
        .map(|(known, _)| *known)
        .filter(|known| known.len() >= MIN_NEAR_NAME_CHARS)
        .any(|known| within_one_edit(&name, &known.chars().collect::<Vec<_>>()))
}

/// True when `a` and `b` are equal or one edit apart.
fn within_one_edit(a: &[char], b: &[char]) -> bool {
    let same = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let (a, b) = (&a[same..], &b[same..]);
    let swapped = a.len() >= 2 && b.len() >= 2 && a[0] == b[1] && a[1] == b[0] && a[2..] == b[2..];
    (a.len() <= 1 && b.len() <= 1)
        || a.get(1..) == Some(b)
        || b.get(1..) == Some(a)
        || (!a.is_empty() && a.get(1..) == b.get(1..))
        || swapped
}

/// A byte range in the search text.
type Span = SimpleSpan;

/// The pieces of a word or a quoted phrase, with the byte range of the token.
type Located<'a> = (&'a [Piece], Span);

/// The tokens of the search text, each with its byte range.
type Tokens<'src> = MappedInput<'src, Token, Span, &'src [(Token, Span)]>;

type Extra = extra::Full<ParseError, SimpleState<ParseState>, ()>;

/// Parse the search text into an expression.
///
/// Returns `Ok(None)` when the text has no tokens. Each hint and the error
/// have the byte range of their text.
pub(crate) fn parse(text: &str) -> Result<Option<Parsed>, Spanned<SearchError>> {
    let tokens: Vec<(Token, Span)> = tokenize(text)?
        .into_iter()
        .map(|(token, span)| (token, span.into()))
        .collect();
    if tokens.is_empty() {
        return Ok(None);
    }
    let end = Span::from(text.len()..text.len());
    let mut state = SimpleState(ParseState::default());
    let result = grammar()
        .parse_with_state(tokens.split_token_span(end), &mut state)
        .into_result();
    match result {
        Ok(expr) => Ok(Some(Parsed {
            expr,
            hints: state.0.hints,
        })),
        Err(errors) => Err(explain(
            &tokens,
            errors
                .into_iter()
                .next()
                .expect("a failed parse has an error"),
        )),
    }
}

/// The state of one parse.
///
/// Change the state only in `try_map_with`. chumsky does not call a
/// `map_with` closure when it only checks a branch, and the state then
/// drifts.
///
/// chumsky does not rewind the state when the parser backtracks. Thus a
/// branch that changes the state must make the full parse fail when the
/// branch fails.
#[derive(Default)]
struct ParseState {
    /// The levels of parentheses and `not` around the next token.
    depth: usize,
    /// The number of terms that the parser read.
    terms: usize,
    /// The hints about the text, in the sequence of the text.
    hints: Vec<Spanned<SearchHint>>,
}

/// The error of one parse attempt.
#[derive(Clone, Debug)]
struct ParseError {
    kind: ParseErrorKind,
    span: Span,
}

#[derive(Clone, Debug)]
enum ParseErrorKind {
    /// A rule of the search language failed.
    Search(SearchError),
    /// A token does not fit the grammar. [`explain`] names the error.
    Unexpected(Found),
}

/// The token that a grammar error found.
#[derive(Clone, Copy, Debug)]
enum Found {
    End,
    Close,
    Operator(SearchOperator),
    /// A word, a phrase or `(`. The grammar reads each of them as a term or
    /// a group. A term that fails gives a search error at its own position,
    /// and [`ParseError::merge`] keeps that error. A group that fails gives
    /// its error at a later token. Thus no failed parse ends at this kind,
    /// and [`explain`] names it as a `)` that closes nothing.
    Other,
}

impl<'src, L> LabelError<'src, Tokens<'src>, L> for ParseError {
    fn expected_found<E: IntoIterator<Item = L>>(
        _expected: E,
        found: Option<MaybeRef<'src, Token>>,
        span: Span,
    ) -> Self {
        let found = match found.as_deref() {
            None => Found::End,
            Some(Token::Close) => Found::Close,
            Some(token) => operator_of(token).map_or(Found::Other, Found::Operator),
        };
        ParseError {
            kind: ParseErrorKind::Unexpected(found),
            span,
        }
    }
}

impl<'src> Error<'src, Tokens<'src>> for ParseError {
    /// At the same position, a rule of the search language explains the
    /// failure better than a grammar error.
    fn merge(self, other: Self) -> Self {
        match (&self.kind, &other.kind) {
            (ParseErrorKind::Unexpected(_), ParseErrorKind::Search(_)) => other,
            _ => self,
        }
    }
}

/// A failed rule of the search language at `span`.
fn search_error(error: SearchError, span: Span) -> ParseError {
    ParseError {
        kind: ParseErrorKind::Search(error),
        span,
    }
}

/// The operator of `token`. A quoted or escaped word is not an operator.
fn operator_of(token: &Token) -> Option<SearchOperator> {
    match token {
        Token::Word(pieces) => operator_in(pieces),
        _ => None,
    }
}

/// The operator that the pieces of a word spell, if any.
fn operator_in(pieces: &[Piece]) -> Option<SearchOperator> {
    if pieces.iter().any(|piece| piece.escaped) {
        return None;
    }
    let text = text_of(pieces);
    SearchOperator::ALL
        .into_iter()
        .find(|operator| text.eq_ignore_ascii_case(operator.word()))
}

/// Go one level deeper at the token `span`, or fail with `TooDeep` when
/// that is more than [`MAX_DEPTH`].
fn enter(state: &mut ParseState, span: Span) -> Result<(), ParseError> {
    if state.depth == MAX_DEPTH {
        return Err(search_error(SearchError::TooDeep, span));
    }
    state.depth += 1;
    Ok(())
}

/// Go one level back, at the end of a group or a `not` term that [`enter`]
/// started.
fn leave(state: &mut ParseState) {
    state.depth -= 1;
}

/// Count the term at `span`, or fail with `TooManyTerms`.
fn count_term(state: &mut ParseState, span: Span) -> Result<(), ParseError> {
    state.terms += 1;
    if state.terms > MAX_TERMS {
        return Err(search_error(SearchError::TooManyTerms, span));
    }
    Ok(())
}

/// A word, divided at its first unescaped colon after the first character.
/// The check for an adjacent phrase and the term both read the field prefix
/// from this, so that the two agree.
enum WordHead<'a> {
    /// A word with no field prefix.
    Bare(&'a [Piece]),
    /// A word with a field prefix.
    Prefixed {
        /// The text before the colon, as the user typed it.
        prefix: String,
        /// `prefix` in lower case.
        name: String,
        /// The target of `name`, or `None` when it is not a supported field
        /// name.
        target: Option<Target>,
        /// The pieces after the colon.
        value: &'a [Piece],
    },
}

impl<'a> WordHead<'a> {
    /// Divide the word `pieces` at its field prefix.
    fn of(pieces: &'a [Piece]) -> Self {
        let Some(colon) = find_colon(pieces, 1) else {
            return WordHead::Bare(pieces);
        };
        let prefix = text_of(&pieces[..colon]);
        let name = prefix.to_ascii_lowercase();
        let target = target_of(&name);
        WordHead::Prefixed {
            prefix,
            name,
            target,
            value: &pieces[colon + 1..],
        }
    }

    /// True when a quoted phrase with no space before it continues the word.
    /// This is so when the value is empty or `=`. For an identifiers term, it
    /// is also so when the value ends with its type and a colon, or a colon
    /// and `=`. A bare `=` takes such a phrase too.
    fn wants_phrase(&self) -> bool {
        match self {
            WordHead::Bare(pieces) => *pieces == [EQUALS],
            WordHead::Prefixed { target, value, .. } => match value {
                [] | [EQUALS] => true,
                [.., COLON] | [.., COLON, EQUALS] => {
                    *target == Some(Target::Field(Field::Identifiers))
                }
                _ => false,
            },
        }
    }

    /// Make the term of the word, with the quoted phrase that continues the
    /// word, if any. The term is at `span`.
    fn into_term(
        self,
        phrase: Option<&[Piece]>,
        span: Span,
        hints: &mut Vec<Spanned<SearchHint>>,
    ) -> Result<Term, SearchError> {
        let (prefix, name, target, mut value) = match self {
            WordHead::Bare(pieces) => {
                if let Some(phrase) = phrase {
                    if phrase.is_empty() {
                        return Err(SearchError::EmptyPhrase);
                    }
                    return Ok(Term::Bare(TextMatch::Equals(text_of(phrase))));
                }
                return text_match(pieces).map(Term::Bare);
            }
            WordHead::Prefixed {
                prefix,
                name,
                target,
                value,
            } => (prefix, name, target, value),
        };
        let joined: Vec<Piece>;
        if let Some(phrase) = phrase {
            joined = value.iter().chain(phrase).copied().collect();
            value = &joined;
        }
        match target {
            Some(Target::IdentifierType(kind)) => {
                return Ok(Term::Identifier {
                    kind: Some(TextMatch::Equals(kind.to_string())),
                    value: matcher(value, &prefix)?,
                })
            }
            Some(Target::Field(Field::Identifiers)) => return identifier(value, &prefix),
            Some(Target::Field(field)) => {
                return Ok(Term::Field {
                    field,
                    matcher: matcher(value, &prefix)?,
                })
            }
            None => {}
        }
        if value.is_empty() {
            if is_near_field_name(&name) {
                add_unknown_field_hint(hints, &prefix, span);
            }
            return Ok(Term::Bare(TextMatch::Contains(format!("{prefix}:"))));
        }
        if is_custom_column(&name) || UNSUPPORTED_FIELDS.contains(&name.as_str()) {
            return Err(SearchError::UnsupportedField { name: prefix });
        }
        add_unknown_field_hint(hints, &prefix, span);
        Ok(Term::Bare(TextMatch::Contains(format!(
            "{prefix}:{}",
            text_of(value)
        ))))
    }
}

/// Add a hint for an unknown prefix. The hint appears one time for each
/// name.
fn add_unknown_field_hint(hints: &mut Vec<Spanned<SearchHint>>, name: &str, span: Span) {
    let known = hints.iter().any(|hint| match &hint.value {
        SearchHint::UnknownField { name: other } => other.eq_ignore_ascii_case(name),
    });
    if !known {
        hints.push(Spanned {
            value: SearchHint::UnknownField {
                name: name.to_string(),
            },
            span: span.into_range(),
        });
    }
}

/// The operator word `want`.
fn operator<'src>(want: SearchOperator) -> impl Parser<'src, Tokens<'src>, (), Extra> + Clone {
    any_ref()
        .filter(move |token: &&Token| operator_of(token) == Some(want))
        .ignored()
}

/// The grammar of the search language:
///
/// ```text
/// or_expr  = and_expr { "or" and_expr }
/// and_expr = not_expr { [ "and" ] not_expr }
/// not_expr = "not" not_expr | primary
/// primary  = "(" or_expr ")" | phrase | word [ adjacent phrase ]
/// ```
///
/// The grammar gives only the structure. [`explain`] names a failure of the
/// structure, and the domain rules of a term fail with their own error.
fn grammar<'src>() -> impl Parser<'src, Tokens<'src>, Expr, Extra> {
    let word = select_ref! { Token::Word(pieces) => pieces.as_slice() }
        .filter(|pieces: &&[Piece]| operator_in(pieces).is_none());
    let quoted = select_ref! { Token::Quoted(pieces) => pieces.as_slice() };
    let word_with_phrase = word
        .map_with(|pieces, e| (pieces, e.span()))
        .then(quoted.map_with(|pieces, e| (pieces, e.span())))
        .filter(
            |((pieces, word_span), (_, phrase_span)): &(Located<'_>, Located<'_>)| {
                word_span.end == phrase_span.start && WordHead::of(pieces).wants_phrase()
            },
        )
        .map(|((pieces, _), (phrase, _))| (pieces, Some(phrase)));
    let word_expr = choice((word_with_phrase, word.map(|pieces| (pieces, None)))).try_map_with(
        |(pieces, phrase), e: &mut MapExtra<'src, '_, Tokens<'src>, Extra>| {
            let span = e.span();
            let state = &mut e.state().0;
            count_term(state, span)?;
            WordHead::of(pieces)
                .into_term(phrase, span, &mut state.hints)
                .map(Expr::Term)
                .map_err(|error| search_error(error, span))
        },
    );
    let phrase = quoted.try_map_with(
        |pieces: &[Piece], e: &mut MapExtra<'src, '_, Tokens<'src>, Extra>| {
            let span = e.span();
            count_term(&mut e.state().0, span)?;
            if pieces.is_empty() {
                return Err(search_error(SearchError::EmptyPhrase, span));
            }
            Ok(Expr::Term(Term::Bare(TextMatch::Contains(text_of(pieces)))))
        },
    );
    let open =
        just(Token::Open).try_map_with(|_, e: &mut MapExtra<'src, '_, Tokens<'src>, Extra>| {
            let span = e.span();
            enter(&mut e.state().0, span)
        });

    recursive(|or_expr| {
        let group = open
            .ignore_then(or_expr)
            .then_ignore(just(Token::Close))
            .try_map_with(|inner, e: &mut MapExtra<'src, '_, Tokens<'src>, Extra>| {
                leave(&mut e.state().0);
                Ok(inner)
            });
        let primary = choice((group, phrase, word_expr));
        let not_expr = recursive(|not_expr| {
            operator(SearchOperator::Not)
                .try_map_with(|_, e: &mut MapExtra<'src, '_, Tokens<'src>, Extra>| {
                    let span = e.span();
                    enter(&mut e.state().0, span)
                })
                .ignore_then(not_expr)
                .try_map_with(|inner, e: &mut MapExtra<'src, '_, Tokens<'src>, Extra>| {
                    leave(&mut e.state().0);
                    Ok(Expr::Not(Box::new(inner)))
                })
                .or(primary)
        });
        let and_expr = not_expr
            .clone()
            .then(
                operator(SearchOperator::And)
                    .or_not()
                    .ignore_then(not_expr)
                    .repeated()
                    .collect::<Vec<_>>(),
            )
            .map(|(first, rest)| Expr::all(first, rest));
        and_expr
            .clone()
            .then(
                operator(SearchOperator::Or)
                    .ignore_then(and_expr)
                    .repeated()
                    .collect::<Vec<_>>(),
            )
            .map(|(first, rest)| Expr::any(first, rest))
    })
    .then_ignore(end())
}

/// Name a failure of the grammar from its position. An operator just before
/// the failure has no term after it. Otherwise, the token that the parser
/// found decides the error:
/// - An operator has no term before it.
/// - A `)` right after a `(` closes an empty group.
/// - Another `)` closes nothing.
/// - The end of the text leaves a group open.
fn explain(tokens: &[(Token, Span)], error: ParseError) -> Spanned<SearchError> {
    let found = match error.kind {
        ParseErrorKind::Search(value) => {
            return Spanned {
                value,
                span: error.span.into_range(),
            }
        }
        ParseErrorKind::Unexpected(found) => found,
    };
    let before = tokens
        .iter()
        .rev()
        .find(|(_, span)| span.end <= error.span.start);
    if let Some((token, span)) = before {
        if let Some(operator) = operator_of(token) {
            return Spanned {
                value: SearchError::MissingTerm { operator },
                span: span.into_range(),
            };
        }
    }
    let (value, span) = match (found, before) {
        (Found::Operator(operator), _) => (SearchError::MissingTerm { operator }, error.span),
        (Found::Close, Some((Token::Open, open))) => (
            SearchError::EmptyGroup,
            Span::from(open.start..error.span.end),
        ),
        (Found::Close | Found::Other, _) => (SearchError::UnexpectedClosingParenthesis, error.span),
        (Found::End, _) => (SearchError::MissingClosingParenthesis, error.span),
    };
    Spanned {
        value,
        span: span.into_range(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A parse with no ranges, so that a test compares only the expression,
    /// the hints and the error.
    #[derive(Debug, PartialEq)]
    struct Plain {
        expr: Expr,
        hints: Vec<SearchHint>,
    }

    /// [`super::parse`] with no ranges.
    fn parse(text: &str) -> Result<Option<Plain>, SearchError> {
        super::parse(text)
            .map(|parsed| {
                parsed.map(|parsed| Plain {
                    expr: parsed.expr,
                    hints: parsed.hints.into_iter().map(|hint| hint.value).collect(),
                })
            })
            .map_err(|error| error.value)
    }

    fn bare_expr(s: &str) -> Expr {
        Expr::Term(Term::Bare(TextMatch::Contains(s.into())))
    }

    fn field(f: Field, m: Matcher) -> Expr {
        Expr::Term(Term::Field {
            field: f,
            matcher: m,
        })
    }

    fn contains(s: &str) -> Matcher {
        Matcher::Text(TextMatch::Contains(s.into()))
    }

    fn equals(s: &str) -> Matcher {
        Matcher::Text(TextMatch::Equals(s.into()))
    }

    fn expr(text: &str) -> Expr {
        parse(text).unwrap().unwrap().expr
    }

    fn hints(text: &str) -> Vec<SearchHint> {
        parse(text).unwrap().unwrap().hints
    }

    fn identifier_term(kind: Option<TextMatch>, value: Matcher) -> Expr {
        Expr::Term(Term::Identifier { kind, value })
    }

    /// A text of `count` bare words.
    fn words(count: usize) -> String {
        (0..count)
            .map(|i| format!("w{i}"))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// The word `a` in `depth` nested groups.
    fn groups(depth: usize) -> String {
        format!("{}a{}", "(".repeat(depth), ")".repeat(depth))
    }

    #[test]
    fn bare_words_and_together() {
        assert_eq!(
            expr("tolkien rings"),
            Expr::And(vec![bare_expr("tolkien"), bare_expr("rings")])
        );
    }

    #[test]
    fn and_binds_tighter_than_or() {
        assert_eq!(
            expr("a or b c"),
            Expr::Or(vec![
                bare_expr("a"),
                Expr::And(vec![bare_expr("b"), bare_expr("c")])
            ])
        );
    }

    #[test]
    fn explicit_and_and_parentheses() {
        assert_eq!(
            expr("(a or b) and c"),
            Expr::And(vec![
                Expr::Or(vec![bare_expr("a"), bare_expr("b")]),
                bare_expr("c")
            ])
        );
    }

    #[test]
    fn nested_groups_of_the_same_kind_are_flat() {
        assert_eq!(
            expr("(a b) and (c d)"),
            Expr::And(vec![
                bare_expr("a"),
                bare_expr("b"),
                bare_expr("c"),
                bare_expr("d")
            ])
        );
        assert_eq!(
            expr("a or (b or c)"),
            Expr::Or(vec![bare_expr("a"), bare_expr("b"), bare_expr("c")])
        );
        assert_eq!(expr("((a))"), bare_expr("a"));
    }

    #[test]
    fn not_negates_the_next_term_or_group() {
        assert_eq!(
            expr("not a b"),
            Expr::And(vec![Expr::Not(Box::new(bare_expr("a"))), bare_expr("b")])
        );
        assert_eq!(
            expr("not (a or b)"),
            Expr::Not(Box::new(Expr::Or(vec![bare_expr("a"), bare_expr("b")])))
        );
    }

    #[test]
    fn operators_and_fields_ignore_case() {
        assert_eq!(
            expr("TAGS:x OR Title:y"),
            Expr::Or(vec![
                field(Field::Tags, contains("x")),
                field(Field::Title, contains("y"))
            ])
        );
    }

    #[test]
    fn a_quoted_operator_is_text() {
        assert_eq!(
            expr(r#""not" x"#),
            Expr::And(vec![bare_expr("not"), bare_expr("x")])
        );
    }

    #[test]
    fn an_escaped_operator_is_text() {
        assert_eq!(
            expr(r"\not x"),
            Expr::And(vec![bare_expr("not"), bare_expr("x")])
        );
    }

    #[test]
    fn aliases_map_to_fields() {
        assert_eq!(expr("author:x"), field(Field::Authors, contains("x")));
        assert_eq!(expr("tag:x"), field(Field::Tags, contains("x")));
        assert_eq!(expr("format:x"), field(Field::Formats, contains("x")));
        assert_eq!(expr("language:x"), field(Field::Languages, contains("x")));
        assert_eq!(expr("comment:x"), field(Field::Comments, contains("x")));
        assert_eq!(expr("publisher:x"), field(Field::Publisher, contains("x")));
        assert_eq!(expr("series:x"), field(Field::Series, contains("x")));
        assert_eq!(expr("identifier:1"), identifier_term(None, contains("1")));
    }

    #[test]
    fn a_quoted_value_follows_the_colon_directly() {
        assert_eq!(
            expr(r#"title:"The Ring""#),
            field(Field::Title, contains("The Ring"))
        );
        assert_eq!(
            parse(r#"title: "The Ring""#),
            Err(SearchError::MissingValue {
                prefix: "title".into()
            })
        );
    }

    #[test]
    fn match_kinds() {
        assert_eq!(expr("tags:=science"), field(Field::Tags, equals("science")));
        assert_eq!(
            expr(r#"tags:"=science""#),
            field(Field::Tags, equals("science"))
        );
        assert_eq!(expr(r"tags:\=x"), field(Field::Tags, contains("=x")));
        assert_eq!(expr("series:TRUE"), field(Field::Series, Matcher::Present));
        assert_eq!(
            expr(r#"series:"false""#),
            field(Field::Series, Matcher::Absent)
        );
        assert_eq!(expr("series:=true"), field(Field::Series, equals("true")));
        assert_eq!(expr("true"), bare_expr("true"));
        assert_eq!(
            expr("=x"),
            Expr::Term(Term::Bare(TextMatch::Equals("x".into())))
        );
        assert_eq!(
            expr("tags:#1"),
            field(Field::Tags, contains("#1")),
            "a # before a character that is not a count operator is text"
        );
    }

    #[test]
    fn identifier_forms() {
        let isbn_equals = Some(TextMatch::Equals("isbn".into()));
        assert_eq!(
            expr("identifiers:true"),
            identifier_term(None, Matcher::Present)
        );
        assert_eq!(
            expr("identifiers:false"),
            identifier_term(None, Matcher::Absent)
        );
        assert_eq!(
            expr("identifiers:123"),
            identifier_term(None, contains("123"))
        );
        assert_eq!(
            expr("identifiers:=123"),
            identifier_term(None, equals("123"))
        );
        assert_eq!(
            expr("identifiers:isbn:123"),
            identifier_term(Some(TextMatch::Contains("isbn".into())), contains("123"))
        );
        assert_eq!(
            expr("identifiers:=isbn:"),
            identifier_term(isbn_equals.clone(), Matcher::Present)
        );
        assert_eq!(
            expr("identifiers:=isbn:false"),
            identifier_term(isbn_equals.clone(), Matcher::Absent)
        );
        assert_eq!(
            expr("identifiers:=isbn:=9780547928227"),
            identifier_term(isbn_equals.clone(), equals("9780547928227"))
        );
        assert_eq!(
            expr("isbn:9780547928227"),
            identifier_term(isbn_equals, contains("9780547928227"))
        );
    }

    #[test]
    fn unknown_prefix_is_text_with_hint() {
        let parsed = parse("titel:dune").unwrap().unwrap();
        assert_eq!(parsed.expr, bare_expr("titel:dune"));
        assert_eq!(
            parsed.hints,
            vec![SearchHint::UnknownField {
                name: "titel".into()
            }]
        );

        let parsed = parse("Star Wars: A New Hope").unwrap().unwrap();
        assert_eq!(
            parsed.expr,
            Expr::And(vec![
                bare_expr("Star"),
                bare_expr("Wars:"),
                bare_expr("A"),
                bare_expr("New"),
                bare_expr("Hope")
            ])
        );
        assert!(parsed.hints.is_empty());

        assert_eq!(
            hints("titel:a Titel:b"),
            vec![SearchHint::UnknownField {
                name: "titel".into()
            }]
        );

        let parsed = parse(r#"foo:"bar baz""#).unwrap().unwrap();
        assert_eq!(parsed.expr, bare_expr("foo:bar baz"));
        assert_eq!(parsed.hints.len(), 1);

        assert_eq!(
            hints("título:x"),
            vec![SearchHint::UnknownField {
                name: "título".into()
            }]
        );
    }

    #[test]
    fn a_quoted_colon_is_text() {
        let parsed = parse(r#""title:dune""#).unwrap().unwrap();
        assert_eq!(parsed.expr, bare_expr("title:dune"));
        assert!(parsed.hints.is_empty());
    }

    #[test]
    fn an_escaped_or_leading_colon_is_text() {
        for (text, value) in [(r"title\:x", "title:x"), (":x", ":x")] {
            let parsed = parse(text).unwrap().unwrap();
            assert_eq!(parsed.expr, bare_expr(value), "input: {text}");
            assert!(parsed.hints.is_empty(), "input: {text}");
        }
    }

    #[test]
    fn errors_match_the_spec() {
        let missing_term = |operator| SearchError::MissingTerm { operator };
        let missing_value = |prefix: &str| SearchError::MissingValue {
            prefix: prefix.into(),
        };
        let unsupported = |name: &str| SearchError::UnsupportedField { name: name.into() };
        let half = MAX_DEPTH / 2;
        let not_groups = format!("{}(a{}", "not (".repeat(half), ")".repeat(half + 1));
        let cases: Vec<(String, SearchError)> = vec![
            (r#"tags:"science"#.into(), SearchError::MissingClosingQuote),
            (
                "(tags:a or tags:b".into(),
                SearchError::MissingClosingParenthesis,
            ),
            ("(".into(), SearchError::MissingClosingParenthesis),
            ("a (".into(), SearchError::MissingClosingParenthesis),
            ("tags:a)".into(), SearchError::UnexpectedClosingParenthesis),
            (")".into(), SearchError::UnexpectedClosingParenthesis),
            (") a".into(), SearchError::UnexpectedClosingParenthesis),
            ("()".into(), SearchError::EmptyGroup),
            (r#""""#.into(), SearchError::EmptyPhrase),
            ("tags:a or".into(), missing_term(SearchOperator::Or)),
            ("not".into(), missing_term(SearchOperator::Not)),
            ("or tags:a".into(), missing_term(SearchOperator::Or)),
            ("a and".into(), missing_term(SearchOperator::And)),
            ("a AND".into(), missing_term(SearchOperator::And)),
            ("a and or b".into(), missing_term(SearchOperator::And)),
            ("a or or b".into(), missing_term(SearchOperator::Or)),
            ("not or a".into(), missing_term(SearchOperator::Not)),
            ("and a".into(), missing_term(SearchOperator::And)),
            ("a not".into(), missing_term(SearchOperator::Not)),
            ("(not)".into(), missing_term(SearchOperator::Not)),
            ("(a or)".into(), missing_term(SearchOperator::Or)),
            ("tags:".into(), missing_value("tags")),
            ("tags:=".into(), missing_value("tags")),
            ("identifiers:".into(), missing_value("identifiers")),
            (r#"tags:"""#.into(), missing_value("tags")),
            ("rating:>=4".into(), unsupported("rating")),
            ("#genre:x".into(), unsupported("#genre")),
            ("Rating:x".into(), unsupported("Rating")),
            (
                "tags:~fan".into(),
                SearchError::UnsupportedSearchKind(SearchKind::RegularExpression),
            ),
            (
                "tags:^fan".into(),
                SearchError::UnsupportedSearchKind(SearchKind::CharacterVariant),
            ),
            (
                "tags:=..WWII".into(),
                SearchError::UnsupportedSearchKind(SearchKind::Hierarchy),
            ),
            (
                "tags:#>4".into(),
                SearchError::UnsupportedSearchKind(SearchKind::Count),
            ),
            (
                "tags:#!x".into(),
                SearchError::UnsupportedSearchKind(SearchKind::Count),
            ),
            (
                "tags:#<3".into(),
                SearchError::UnsupportedSearchKind(SearchKind::Count),
            ),
            (
                "identifiers:~isbn:1".into(),
                SearchError::UnsupportedSearchKind(SearchKind::RegularExpression),
            ),
            (
                "identifiers:=.isbn:1".into(),
                SearchError::UnsupportedSearchKind(SearchKind::Hierarchy),
            ),
            (
                "identifiers:^isbn:1".into(),
                SearchError::UnsupportedSearchKind(SearchKind::CharacterVariant),
            ),
            (
                "identifiers:#=x:1".into(),
                SearchError::UnsupportedSearchKind(SearchKind::Count),
            ),
            (
                "identifiers:=:1".into(),
                SearchError::MissingIdentifierType {
                    name: "identifiers".into(),
                },
            ),
            (
                "identifiers:isbn:=".into(),
                missing_value("identifiers:isbn"),
            ),
            (
                "identifier:=isbn:=".into(),
                missing_value("identifier:=isbn"),
            ),
            (words(MAX_TERMS + 1), SearchError::TooManyTerms),
            (groups(MAX_DEPTH + 1), SearchError::TooDeep),
            (
                format!("{}a", "not ".repeat(MAX_DEPTH + 1)),
                SearchError::TooDeep,
            ),
            (not_groups, SearchError::TooDeep),
        ];
        for (input, error) in cases {
            assert_eq!(parse(&input), Err(error), "input: {input}");
        }
    }

    #[test]
    fn each_unsupported_calibre_field_is_an_error() {
        let names = [
            "all",
            "author_sort",
            "cover",
            "date",
            "id",
            "in_tag_browser",
            "last_modified",
            "marked",
            "ondevice",
            "pubdate",
            "rating",
            "search",
            "series_index",
            "series_sort",
            "size",
            "template",
            "timestamp",
            "title_sort",
            "uuid",
            "vl",
        ];
        for name in names {
            for typed in [name.to_string(), name.to_ascii_uppercase()] {
                assert_eq!(
                    parse(&format!("{typed}:x")),
                    Err(SearchError::UnsupportedField {
                        name: typed.clone()
                    }),
                    "input: {typed}:x"
                );
            }
        }
    }

    #[test]
    fn limits_allow_the_maximum() {
        let Expr::And(operands) = expr(&words(MAX_TERMS)) else {
            panic!("100 words must make one And");
        };
        assert_eq!(operands.len(), MAX_TERMS);
        assert_eq!(expr(&groups(MAX_DEPTH)), bare_expr("a"));
        let half = MAX_DEPTH / 2;
        let not_groups = format!("{}a{}", "not (".repeat(half), ")".repeat(half));
        assert!(
            parse(&not_groups).is_ok(),
            "each not and each group is one level"
        );
    }

    #[test]
    fn the_largest_valid_search_fits_the_token_limit() {
        let term = format!(
            "{}title:\"x\"{}",
            "(".repeat(MAX_DEPTH),
            ")".repeat(MAX_DEPTH)
        );
        let largest = vec![term; MAX_TERMS].join(" and ");
        assert!(parse(&largest).is_ok());
    }

    #[test]
    fn a_quoted_phrase_after_an_equals_sign_joins_the_value() {
        assert_eq!(
            expr(r#"title:="The Ring""#),
            field(Field::Title, equals("The Ring"))
        );
        assert_eq!(
            parse("title:="),
            Err(SearchError::MissingValue {
                prefix: "title".into()
            })
        );
        assert_eq!(
            parse(r#"title:="""#),
            Err(SearchError::MissingValue {
                prefix: "title".into()
            })
        );
        assert_eq!(
            expr(r#"title:\="x""#),
            Expr::And(vec![field(Field::Title, contains("=")), bare_expr("x")]),
            "an escaped equals sign keeps its old meaning"
        );
    }

    #[test]
    fn field_names_fold_ascii_case_only() {
        let parsed = parse("MAR\u{212A}ED:x").unwrap().unwrap();
        assert_eq!(parsed.expr, bare_expr("MAR\u{212A}ED:x"));
        assert_eq!(
            parsed.hints,
            vec![SearchHint::UnknownField {
                name: "MAR\u{212A}ED".into()
            }]
        );
    }

    #[test]
    fn an_isbn_prefix_with_no_value_is_an_error() {
        for text in ["isbn:", "isbn:=", "ISBN: 9780547928227"] {
            let prefix = text.split(':').next().unwrap();
            assert_eq!(
                parse(text),
                Err(SearchError::MissingValue {
                    prefix: prefix.into()
                }),
                "input: {text}"
            );
        }
        let isbn = Some(TextMatch::Equals("isbn".into()));
        assert_eq!(
            expr("isbn:true"),
            identifier_term(isbn.clone(), Matcher::Present)
        );
        assert_eq!(expr("isbn:false"), identifier_term(isbn, Matcher::Absent));
    }

    #[test]
    fn a_pasted_title_with_a_colon_runs() {
        let parsed = parse("Marked: A House of Night Novel").unwrap().unwrap();
        assert_eq!(
            parsed.expr,
            Expr::And(
                ["Marked:", "A", "House", "of", "Night", "Novel"]
                    .map(bare_expr)
                    .into()
            )
        );
        assert!(parsed.hints.is_empty());

        let parsed = parse("Wings of Fire #1: The Dragonet Prophecy")
            .unwrap()
            .unwrap();
        assert_eq!(
            parsed.expr,
            Expr::And(
                ["Wings", "of", "Fire", "#1:", "The", "Dragonet", "Prophecy"]
                    .map(bare_expr)
                    .into()
            )
        );
        assert!(parsed.hints.is_empty());

        assert_eq!(expr("rating:"), bare_expr("rating:"));
        assert_eq!(
            hints("#1:x"),
            vec![SearchHint::UnknownField { name: "#1".into() }]
        );
    }

    #[test]
    fn a_quoted_value_joins_an_identifier_type() {
        let isbn = Some(TextMatch::Equals("isbn".into()));
        assert_eq!(
            expr(r#"identifiers:=isbn:"9780547928227""#),
            identifier_term(isbn.clone(), contains("9780547928227"))
        );
        assert_eq!(
            expr(r#"identifier:=isbn:="9780547928227""#),
            identifier_term(isbn, equals("9780547928227"))
        );
        assert_eq!(
            expr(r#"identifiers:isbn: "1""#),
            Expr::And(vec![
                identifier_term(Some(TextMatch::Contains("isbn".into())), Matcher::Present),
                bare_expr("1")
            ]),
            "a space ends the term"
        );
    }

    #[test]
    fn a_prefix_one_edit_from_a_field_name_has_a_hint() {
        for (text, name) in [
            ("titel: dune", "titel"),
            ("autor: herbert", "autor"),
            ("Tagss: x", "Tagss"),
            ("isb: 1", "isb"),
            ("tgs: x", "tgs"),
        ] {
            assert_eq!(
                hints(text),
                vec![SearchHint::UnknownField { name: name.into() }],
                "input: {text}"
            );
        }
        for text in [
            "Star Wars: A New Hope",
            "Dune: Messiah",
            "ti: x",
            "Tao: The Watercourse Way",
            "Tab: x",
            "Nag: x",
        ] {
            assert!(hints(text).is_empty(), "input: {text}");
        }
    }

    #[test]
    fn bare_words_with_a_search_kind_character() {
        assert_eq!(
            parse("~x"),
            Err(SearchError::UnsupportedSearchKind(
                SearchKind::RegularExpression
            ))
        );
        assert_eq!(expr("="), bare_expr("="));
        assert_eq!(expr(r#""=x""#), bare_expr("=x"));
        assert_eq!(
            expr(r#"="frank herbert""#),
            Expr::Term(Term::Bare(TextMatch::Equals("frank herbert".into()))),
            "a bare = takes the next phrase, as a field prefix does"
        );
        assert_eq!(
            expr(r#"= "frank herbert""#),
            Expr::And(vec![bare_expr("="), bare_expr("frank herbert")]),
            "a space ends the term"
        );
        assert_eq!(parse(r#"="""#), Err(SearchError::EmptyPhrase));
    }

    #[test]
    fn an_escaped_true_or_false_is_text() {
        assert_eq!(expr(r"tags:\true"), field(Field::Tags, contains("true")));
        assert_eq!(expr(r"tags:\false"), field(Field::Tags, contains("false")));
    }

    #[test]
    fn identifier_values_with_extra_colons() {
        assert_eq!(expr("identifiers::x"), identifier_term(None, contains("x")));
        assert_eq!(
            expr(r#"identifiers:"isbn:1""#),
            identifier_term(Some(TextMatch::Contains("isbn".into())), contains("1"))
        );
    }

    #[test]
    fn a_quoted_phrase_after_an_equals_sign_joins_an_unknown_prefix() {
        let parsed = parse(r#"foo:="x y""#).unwrap().unwrap();
        assert_eq!(parsed.expr, bare_expr("foo:=x y"));
        assert_eq!(
            parsed.hints,
            vec![SearchHint::UnknownField { name: "foo".into() }]
        );
    }

    #[test]
    fn hints_keep_the_order_of_the_text() {
        assert_eq!(
            hints("foo:1 bar:2"),
            vec![
                SearchHint::UnknownField { name: "foo".into() },
                SearchHint::UnknownField { name: "bar".into() },
            ]
        );
    }

    #[test]
    fn nested_nots_stop_at_the_depth_limit() {
        assert!(parse(&format!("{}a", "not ".repeat(MAX_DEPTH))).is_ok());
        assert!(parse(&"not a ".repeat(40)).is_ok());
    }

    #[test]
    fn blank_text_has_no_expression() {
        assert_eq!(parse("   "), Ok(None));
    }

    /// The error of `text`, with its range.
    fn spanned_error(text: &str) -> (SearchError, std::ops::Range<usize>) {
        let error = super::parse(text).unwrap_err();
        (error.value, error.span)
    }

    #[test]
    fn hints_and_errors_have_the_range_of_their_text() {
        let parsed = super::parse("dune titel:x").unwrap().unwrap();
        assert_eq!(
            parsed.hints,
            vec![Spanned {
                value: SearchHint::UnknownField {
                    name: "titel".into()
                },
                span: 5..12
            }]
        );
        let and = SearchOperator::And;
        let missing_and = SearchError::MissingTerm { operator: and };
        assert_eq!(spanned_error("x and"), (missing_and.clone(), 2..5));
        assert_eq!(spanned_error("x and )"), (missing_and, 2..5));
        assert_eq!(spanned_error("a ()"), (SearchError::EmptyGroup, 2..4));
        assert_eq!(
            spanned_error("a (b"),
            (SearchError::MissingClosingParenthesis, 4..4)
        );
        assert_eq!(
            spanned_error("x )"),
            (SearchError::UnexpectedClosingParenthesis, 2..3)
        );
        assert_eq!(
            spanned_error("x tags:\"sci"),
            (SearchError::MissingClosingQuote, 7..11)
        );
        assert_eq!(
            spanned_error("x tags:"),
            (
                SearchError::MissingValue {
                    prefix: "tags".into()
                },
                2..7
            )
        );
        assert_eq!(
            spanned_error("x =\"\""),
            (SearchError::EmptyPhrase, 2..5),
            "the equals sign with its adjacent phrase"
        );
        assert_eq!(
            spanned_error(&groups(MAX_DEPTH + 1)),
            (SearchError::TooDeep, MAX_DEPTH..MAX_DEPTH + 1)
        );
    }
}
