use serde::{Deserialize, Serialize};
use specta::Type;

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/// The metadata sources Citadel can look books up against. The serialized
/// short form is the single id used across the Rust enum, the TS string union,
/// and the frontend registry keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum MetadataProvider {
    #[serde(rename = "hardcover")]
    Hardcover,
    #[serde(rename = "loc")]
    Loc,
    #[serde(rename = "dnb")]
    Dnb,
    #[serde(rename = "k10plus")]
    K10plus,
    #[serde(rename = "openlibrary")]
    OpenLibrary,
}

impl std::str::FromStr for MetadataProvider {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "hardcover" => Ok(Self::Hardcover),
            "loc" => Ok(Self::Loc),
            "dnb" => Ok(Self::Dnb),
            "k10plus" => Ok(Self::K10plus),
            "openlibrary" => Ok(Self::OpenLibrary),
            other => Err(format!("unknown metadata provider: {other}")),
        }
    }
}

impl MetadataProvider {
    /// The identifier label a record from this provider is stored under on a
    /// book, so several providers' ids can coexist on one book.
    pub fn identifier_label(self) -> &'static str {
        match self {
            Self::Hardcover => "hardcover",
            Self::Loc => "lccn",
            Self::Dnb => "dnb",
            Self::K10plus => "k10plus",
            Self::OpenLibrary => "openlibrary",
        }
    }
}

// ---------------------------------------------------------------------------
// Boundary types (shared by every provider, exported to TS via specta)
// ---------------------------------------------------------------------------

/// A book record from a provider. Providers return these fully populated from a
/// single search call — there is no separate resolve step, so the cover-less
/// MARC sources' subjects/publisher/language survive into the applied record.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BookMetadata {
    pub provider: MetadataProvider,
    /// Provider-native id: hardcover id (stringified), LCCN, DNB control
    /// number, or Open Library OLID.
    pub provider_id: String,
    pub identifier_label: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub authors: Vec<String>,
    pub isbn: Option<String>,
    pub release_year: Option<i32>,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub publisher: Option<String>,
    /// Subject headings, mapped to tag suggestions on the frontend.
    pub subjects: Vec<String>,
    /// Explicit provider genre/form terms. Subject headings are never placed
    /// here merely because they look genre-like.
    pub genre_candidates: Vec<GenreCandidate>,
    /// MARC 3-letter language code. Parsed now; applied once CDL-2 lands.
    pub language_code: Option<String>,
    /// Hardcover deep-link slug; `None` for other providers.
    pub slug: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GenreCandidate {
    pub name: String,
    /// Stable provider field identity, such as `hardcover:genre` or
    /// `marc:655`.
    pub source: String,
    /// Provider vocabulary or thesaurus when one is declared.
    pub vocabulary: Option<String>,
}

pub fn normalize_genre_candidates(
    candidates: impl IntoIterator<Item = GenreCandidate>,
) -> Vec<GenreCandidate> {
    let mut normalized = Vec::<GenreCandidate>::new();
    for mut candidate in candidates {
        candidate.name = candidate
            .name
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if candidate.name.is_empty()
            || normalized
                .iter()
                .any(|existing| existing.name.eq_ignore_ascii_case(&candidate.name))
        {
            continue;
        }
        normalized.push(candidate);
    }
    normalized
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProviderStatus {
    pub provider: MetadataProvider,
    pub is_valid: bool,
    pub message: String,
}

// ---------------------------------------------------------------------------
// ISBN normalization & equivalence (the single 10<->13 authority)
// ---------------------------------------------------------------------------

/// Normalize a raw ISBN string into a compact, validated form (13 digits, or
/// 10 digits with an optional trailing `X`). Returns `None` if the input is
/// not a structurally valid ISBN.
pub fn normalize_isbn(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_prefix = trimmed
        .strip_prefix("ISBN:")
        .or_else(|| trimmed.strip_prefix("isbn:"))
        .unwrap_or(trimmed)
        .trim();

    let compact: String = without_prefix
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if compact.is_empty() {
        return None;
    }

    let upper = compact.to_uppercase();
    let valid = upper.len() == 13 && upper.chars().all(|c| c.is_ascii_digit())
        || (upper.len() == 10
            && upper[..9].chars().all(|c| c.is_ascii_digit())
            && upper[9..].chars().all(|c| c.is_ascii_digit() || c == 'X'));
    if valid {
        Some(upper)
    } else {
        None
    }
}

/// Choose the best ISBN from a list, preferring the 13-digit form.
pub fn pick_preferred_isbn(isbns: &[String]) -> Option<String> {
    let normalized: Vec<String> = isbns
        .iter()
        .filter_map(|isbn| normalize_isbn(isbn))
        .collect();
    normalized
        .iter()
        .find(|isbn| isbn.len() == 13)
        .cloned()
        .or_else(|| normalized.into_iter().next())
}

/// Canonicalize any valid ISBN to its 13-digit form so that the ISBN-10 and
/// ISBN-13 representations of the same edition compare equal.
fn canonical_isbn13(raw: &str) -> Option<String> {
    let n = normalize_isbn(raw)?;
    match n.len() {
        13 => Some(n),
        10 => {
            let core: String = format!("978{}", &n[..9]);
            let check = ean13_check_digit(&core)?;
            Some(format!("{core}{check}"))
        }
        _ => None,
    }
}

fn ean13_check_digit(twelve: &str) -> Option<char> {
    if twelve.len() != 12 {
        return None;
    }
    let mut sum = 0u32;
    for (i, c) in twelve.chars().enumerate() {
        let d = c.to_digit(10)?;
        sum += if i % 2 == 0 { d } else { d * 3 };
    }
    let check = (10 - (sum % 10)) % 10;
    char::from_digit(check, 10)
}

/// True when two ISBN strings denote the same edition, comparing across the
/// ISBN-10 and ISBN-13 forms. This is the only place 10<->13 conversion lives;
/// the frontend relies on Rust having verified equivalence.
pub fn isbn_equivalent(a: &str, b: &str) -> bool {
    match (canonical_isbn13(a), canonical_isbn13(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_and_strips_prefixes() {
        assert_eq!(
            normalize_isbn("ISBN: 978-0-553-10354-0").as_deref(),
            Some("9780553103540")
        );
        assert_eq!(normalize_isbn("0553103547").as_deref(), Some("0553103547"));
        assert_eq!(normalize_isbn("notanisbn"), None);
    }

    #[test]
    fn isbn_10_and_13_are_equivalent() {
        // A Game of Thrones, ISBN-10 vs ISBN-13 for the same edition.
        assert!(isbn_equivalent("0553103547", "9780553103540"));
        assert!(isbn_equivalent("9780553103540", "0553103547"));
        // Same form compares equal.
        assert!(isbn_equivalent("9780553103540", "978-0-553-10354-0"));
        // Different editions do not.
        assert!(!isbn_equivalent("9780553103540", "9780374528379"));
    }

    #[test]
    fn equivalence_is_false_for_garbage() {
        assert!(!isbn_equivalent("", "9780553103540"));
        assert!(!isbn_equivalent("xyz", "9780553103540"));
    }

    #[test]
    fn genres_are_trimmed_deduplicated_and_keep_first_provenance() {
        let genres = normalize_genre_candidates([
            GenreCandidate {
                name: "  Science   Fiction ".to_string(),
                source: "hardcover:genre".to_string(),
                vocabulary: Some("hardcover".to_string()),
            },
            GenreCandidate {
                name: "science fiction".to_string(),
                source: "marc:655".to_string(),
                vocabulary: Some("lcgft".to_string()),
            },
            GenreCandidate {
                name: "  ".to_string(),
                source: "marc:655".to_string(),
                vocabulary: None,
            },
        ]);
        assert_eq!(genres.len(), 1);
        assert_eq!(genres[0].name, "Science Fiction");
        assert_eq!(genres[0].source, "hardcover:genre");
    }
}
