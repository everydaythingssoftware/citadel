//! The lexer of the search language: it changes the text into tokens.

use std::ops::Range;

use logos::Logos;

use super::{SearchError, Spanned, MAX_DEPTH, MAX_TERMS};

/// The most tokens that a search text can make. Each term of a valid search
/// takes a maximum of `2 * MAX_DEPTH` tokens for its parentheses and `not`
/// words. It also takes one word, one quoted phrase after `field:` and one
/// operator.
const MAX_TOKENS: usize = MAX_TERMS * (2 * MAX_DEPTH + 3);

/// One character of a word or a quoted phrase.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Piece {
    /// The character.
    pub(crate) ch: char,
    /// True when a backslash came before the character.
    pub(crate) escaped: bool,
}

/// A token of the search text. Whitespace divides tokens and is not a token.
#[derive(Logos, Clone, Debug, PartialEq, Eq)]
#[logos(skip r"\s+")]
pub(crate) enum Token {
    /// A run of characters with no unescaped whitespace, quote or
    /// parenthesis. It has one or more pieces.
    #[regex(r#"([^\s"()\\]|\\(?s:.))+"#, |lex| pieces(lex.slice()))]
    #[token("\\", |_| vec![Piece { ch: '\\', escaped: false }])]
    Word(Vec<Piece>),
    /// A phrase between two quotes. It can have no pieces.
    #[regex(r#""([^"\\]|\\(?s:.))*""#, |lex| {
        let slice = lex.slice();
        pieces(&slice[1..slice.len() - 1])
    })]
    Quoted(Vec<Piece>),
    /// An opening parenthesis.
    #[token("(")]
    Open,
    /// A closing parenthesis.
    #[token(")")]
    Close,
}

/// The pieces of `text`. A backslash escapes the next character.
fn pieces(text: &str) -> Vec<Piece> {
    let mut chars = text.chars();
    let mut pieces = Vec::new();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.next() {
                pieces.push(Piece {
                    ch: next,
                    escaped: true,
                });
                continue;
            }
        }
        pieces.push(Piece { ch, escaped: false });
    }
    pieces
}

/// Divide the search text into tokens, each with its byte range in `text`.
///
/// A backslash at the end of the text stays a backslash. It continues the
/// word before it when no whitespace comes between them.
///
/// Returns `MissingClosingQuote` when a quoted phrase has no end, with the
/// range from the quote to the end of the text. Returns `TooLong` when the
/// text makes more than `MAX_TOKENS` tokens.
pub(crate) fn tokenize(text: &str) -> Result<Vec<(Token, Range<usize>)>, Spanned<SearchError>> {
    let mut tokens: Vec<(Token, Range<usize>)> = Vec::new();
    for (token, span) in Token::lexer(text).spanned() {
        let Ok(token) = token else {
            return Err(Spanned {
                value: SearchError::MissingClosingQuote,
                span: span.start..text.len(),
            });
        };
        if let (Token::Word(tail), Some((Token::Word(word), word_span))) =
            (&token, tokens.last_mut())
        {
            if word_span.end == span.start {
                word.extend(tail);
                word_span.end = span.end;
                continue;
            }
        }
        if tokens.len() == MAX_TOKENS {
            return Err(Spanned {
                value: SearchError::TooLong,
                span,
            });
        }
        tokens.push((token, span));
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tokens of `text`, with no ranges.
    fn tokens(text: &str) -> Vec<Token> {
        tokenize(text)
            .unwrap()
            .into_iter()
            .map(|(token, _)| token)
            .collect()
    }

    /// The pieces of a word or a phrase. A parenthesis has none.
    fn pieces_of(token: &Token) -> &[Piece] {
        match token {
            Token::Word(pieces) | Token::Quoted(pieces) => pieces,
            Token::Open | Token::Close => &[],
        }
    }

    fn text(token: &Token) -> String {
        pieces_of(token).iter().map(|piece| piece.ch).collect()
    }

    /// The kind of a token, with no pieces.
    fn shape(token: &Token) -> &'static str {
        match token {
            Token::Word(_) => "word",
            Token::Quoted(_) => "quoted",
            Token::Open => "open",
            Token::Close => "close",
        }
    }

    fn error(text: &str) -> (SearchError, Range<usize>) {
        let error = tokenize(text).unwrap_err();
        (error.value, error.span)
    }

    #[test]
    fn words_and_quotes() {
        let tokens = tokenize(r#"tags:"science fiction" dune"#).unwrap();
        assert_eq!(
            tokens
                .iter()
                .map(|(t, span)| (shape(t), text(t), span.clone()))
                .collect::<Vec<_>>(),
            vec![
                ("word", "tags:".into(), 0..5),
                ("quoted", "science fiction".into(), 5..22),
                ("word", "dune".into(), 23..27),
            ]
        );
    }

    #[test]
    fn a_space_before_a_quote_separates_the_ranges() {
        let tokens = tokenize(r#"title: "x""#).unwrap();
        assert_eq!(tokens[0].1, 0..6);
        assert_eq!(tokens[1].1, 7..10);
    }

    #[test]
    fn parentheses_are_tokens() {
        let kinds: Vec<_> = tokenize("(a)b")
            .unwrap()
            .iter()
            .map(|(t, span)| (shape(t), span.clone()))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("open", 0..1),
                ("word", 1..2),
                ("close", 2..3),
                ("word", 3..4)
            ]
        );
    }

    #[test]
    fn escapes_give_literal_characters() {
        let tokens = tokens(r#"Dune\(1965\) "a\"b" \=x"#);
        assert_eq!(tokens.len(), 3);
        assert_eq!(text(&tokens[0]), "Dune(1965)");
        assert_eq!(text(&tokens[1]), "a\"b");
        let escaped = |token: &Token, ch: char| {
            pieces_of(token)
                .iter()
                .any(|piece| piece.ch == ch && piece.escaped)
        };
        assert!(escaped(&tokens[0], '('));
        assert!(escaped(&tokens[0], ')'));
        assert!(escaped(&tokens[1], '"'));
        assert_eq!(
            pieces_of(&tokens[2])[0],
            Piece {
                ch: '=',
                escaped: true
            }
        );
    }

    #[test]
    fn a_trailing_backslash_stays() {
        let tokens = tokenize("a\\").unwrap();
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].1, 0..2);
        assert_eq!(
            pieces_of(&tokens[0].0)[1],
            Piece {
                ch: '\\',
                escaped: false
            }
        );
    }

    #[test]
    fn a_trailing_backslash_after_a_space_is_a_word() {
        assert_eq!(
            tokens("a \\"),
            vec![
                Token::Word(vec![Piece {
                    ch: 'a',
                    escaped: false
                }]),
                Token::Word(vec![Piece {
                    ch: '\\',
                    escaped: false
                }]),
            ]
        );
    }

    #[test]
    fn a_missing_closing_quote_is_an_error() {
        assert_eq!(
            error(r#"tags:"science"#),
            (SearchError::MissingClosingQuote, 5..13)
        );
    }

    #[test]
    fn an_empty_phrase_has_no_pieces() {
        assert_eq!(tokens(r#""""#), vec![Token::Quoted(Vec::new())]);
    }

    #[test]
    fn an_escaped_backslash_is_one_piece() {
        assert_eq!(
            tokens(r"\\"),
            vec![Token::Word(vec![Piece {
                ch: '\\',
                escaped: true
            }])]
        );
    }

    #[test]
    fn an_escaped_backslash_in_a_phrase_is_one_backslash() {
        let tokens = tokens(r#""a\\b""#);
        assert_eq!(tokens.len(), 1);
        assert_eq!(shape(&tokens[0]), "quoted");
        assert_eq!(text(&tokens[0]), r"a\b");
    }

    #[test]
    fn a_phrase_keeps_parentheses_and_whitespace() {
        let tokens = tokens(r#""a (b) c""#);
        assert_eq!(tokens.len(), 1);
        assert_eq!(shape(&tokens[0]), "quoted");
        assert_eq!(text(&tokens[0]), "a (b) c");
    }

    #[test]
    fn an_escaped_quote_at_the_end_leaves_the_phrase_open() {
        assert_eq!(error(r#""abc\""#), (SearchError::MissingClosingQuote, 0..6));
    }

    #[test]
    fn too_many_tokens_are_refused() {
        assert_eq!(
            tokenize(&"(".repeat(MAX_TOKENS)).map(|t| t.len()),
            Ok(MAX_TOKENS)
        );
        assert_eq!(
            error(&"(".repeat(MAX_TOKENS + 1)),
            (SearchError::TooLong, MAX_TOKENS..MAX_TOKENS + 1)
        );
    }

    #[test]
    fn unicode_text_keeps_its_characters_and_byte_ranges() {
        let tokens = tokenize(r#"título:"Café ñ""#).unwrap();
        assert_eq!(text(&tokens[0].0), "título:");
        assert_eq!(tokens[0].1, 0..8);
        assert_eq!(text(&tokens[1].0), "Café ñ");
        assert_eq!(tokens[1].1, 8..18);
    }

    #[test]
    fn unicode_whitespace_divides_tokens() {
        assert_eq!(tokens("a\u{a0}b\u{2003}c").len(), 3);
    }
}
