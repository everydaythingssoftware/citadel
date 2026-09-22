//! The generated-password chunk shape and algorithm.

use super::words::WORD_POOL;
use serde::Serialize;

/// Returned once when credentials are generated; the plaintext is never
/// stored, so this is the only chance to copy it into a reader.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedOpdsCredentials {
    pub username: String,
    pub password: String,
}

/// Symbols that survive e-reader input fields and `user:pass@host` logins.
pub(crate) const PASSWORD_SYMBOLS: &[char] = &['!', '*', '-', '=', '~', '$'];

/// Generates a password in a fixed, chunked shape:
/// `word` + three digits (2-9) + one symbol + `word`, e.g. `wren724=wolf`.
/// Lowercase words from a curated pool, digits without 0/1, symbols from a
/// URL-safe set (`! * - = ~ $`) so readers that paste credentials into
/// `http://user:pass@host/` logins cannot mangle them. Roughly 30.5 bits: an
/// online-only attacker faces an Argon2-slowed endpoint, and auth failures
/// back off.
/// Symbols that survive e-reader input fields and `user:pass@host` logins.
pub(crate) fn generate_password() -> String {
    use rand_core::{OsRng, RngCore};

    let word = |used_tail: &mut Option<char>| -> String {
        loop {
            let candidates: Vec<&str> = WORD_POOL
                .split_whitespace()
                .filter(|candidate| {
                    // No doubled glyphs inside a word, and the word must not
                    // begin with the character that ended the previous chunk.
                    let chars: Vec<char> = candidate.chars().collect();
                    chars.windows(2).all(|pair| pair[0] != pair[1])
                        && used_tail
                            .map(|tail| chars.first() != Some(&tail))
                            .unwrap_or(true)
                })
                .collect();
            if !candidates.is_empty() {
                let word = candidates[OsRng.next_u32() as usize % candidates.len()];
                *used_tail = word.chars().last();
                return word.to_string();
            }
        }
    };

    // Three digits from 2-9, never two alike in a row: repeated digits read
    // as one digit at a glance and typing a twin twice on e-ink is the
    // classic transcription error.
    let mut digits = String::new();
    let mut last_digit = None;
    for _ in 0..3 {
        let digit = loop {
            let digit = b'2' + (OsRng.next_u32() % 8) as u8;
            if Some(digit as char) != last_digit {
                break digit;
            }
        };
        last_digit = Some(digit as char);
        digits.push(digit as char);
    }

    let symbol = PASSWORD_SYMBOLS[(OsRng.next_u32() % 6) as usize];

    let mut first_tail: Option<char> = None;
    let first_word = word(&mut first_tail);
    let mut second_tail: Option<char> = Some(symbol);
    let second_word = word(&mut second_tail);

    format!("{first_word}{digits}{symbol}{second_word}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_passwords_match_the_chunked_shape() {
        for _ in 0..128 {
            let password = generate_password();
            assert!(password.len() >= 8 && password.len() <= 16);
            assert!(
                password.chars().all(|c| c.is_ascii_lowercase()
                    || ('2'..='9').contains(&c)
                    || PASSWORD_SYMBOLS.contains(&c)),
                "unexpected character in {password}"
            );
            // No adjacent duplicate glyphs anywhere.
            let chars: Vec<char> = password.chars().collect();
            assert!(chars.windows(2).all(|pair| pair[0] != pair[1]));
            // Shape: word + three digits (2-9) + symbol + word.
            let word1_end = password
                .find(|c: char| !c.is_ascii_lowercase())
                .expect("first chunk is a word");
            let body = &password[word1_end..];
            let (digits, rest) = body.split_at(3);
            assert!(digits.bytes().all(|d| (b'2'..=b'9').contains(&d)));
            let (symbol, second_word) = rest.split_at(1);
            assert!(PASSWORD_SYMBOLS.contains(&symbol.chars().next().unwrap()));
            assert!(second_word.chars().all(|c| c.is_ascii_lowercase()));
        }
    }
}
