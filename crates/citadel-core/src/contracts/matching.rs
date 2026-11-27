//! Books the library may already hold, listed before a book is added. A
//! match only informs: nothing is refused for being a possible duplicate.
use serde::{Deserialize, Serialize};

/// A book about to be added, to look for in the library.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Clone, Debug, Default, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookCandidate {
    pub title: String,
    #[serde(default)]
    pub author_names: Vec<String>,
    /// As typed or read from the file: an ISBN-10 or ISBN-13, with or
    /// without hyphens or a `urn:isbn:` prefix. Anything else is ignored.
    #[serde(default)]
    pub identifier: Option<String>,
    /// Any ISO 639 code (`en`, `eng`, `en-US`).
    #[serde(default)]
    pub language: Option<String>,
}

impl From<&BookCandidate> for libcalibre::matching::Candidate {
    fn from(candidate: &BookCandidate) -> Self {
        Self {
            title: candidate.title.clone(),
            author_names: candidate.author_names.clone(),
            isbn: candidate.identifier.clone(),
            languages: candidate.language.iter().cloned().collect(),
        }
    }
}

/// Why a book in the library may be the one being added, strongest first.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum MatchReason {
    /// The same ISBN.
    Isbn,
    /// The same title and at least one author in common.
    TitleAndAuthor,
    /// The same title, where one of the two has no author.
    Title,
}

impl From<libcalibre::matching::MatchReason> for MatchReason {
    fn from(reason: libcalibre::matching::MatchReason) -> Self {
        match reason {
            libcalibre::matching::MatchReason::Isbn => Self::Isbn,
            libcalibre::matching::MatchReason::TitleAndAuthor => Self::TitleAndAuthor,
            libcalibre::matching::MatchReason::Title => Self::Title,
        }
    }
}

/// A book in the library that may be the one being added.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BookMatch {
    /// The library book's ID.
    pub id: String,
    pub title: String,
    pub author_names: Vec<String>,
    /// The formats it has, uppercase (`EPUB`, `PDF`).
    pub formats: Vec<String>,
    /// Its ISBN as stored.
    #[cfg_attr(feature = "openapi", schema(required = true))]
    pub isbn: Option<String>,
    /// When it was added, as an RFC 3339 UTC date-time.
    #[cfg_attr(feature = "openapi", schema(required = true))]
    pub added: Option<String>,
    #[cfg_attr(feature = "openapi", schema(required = true))]
    pub cover_url: Option<String>,
    pub reason: MatchReason,
}
