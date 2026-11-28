use crate::LibraryBook;
use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug)]
pub enum BookSortOrder {
    TitleAsc,
    TitleDesc,
    AuthorAsc,
    AuthorDesc,
    AddedDesc,
    AddedAsc,
}

impl From<BookSortOrder> for libcalibre::BookSortOrder {
    fn from(sort: BookSortOrder) -> Self {
        match sort {
            BookSortOrder::TitleAsc => libcalibre::BookSortOrder::TitleAsc,
            BookSortOrder::TitleDesc => libcalibre::BookSortOrder::TitleDesc,
            BookSortOrder::AuthorAsc => libcalibre::BookSortOrder::AuthorAsc,
            BookSortOrder::AuthorDesc => libcalibre::BookSortOrder::AuthorDesc,
            BookSortOrder::AddedDesc => libcalibre::BookSortOrder::AddedDesc,
            BookSortOrder::AddedAsc => libcalibre::BookSortOrder::AddedAsc,
        }
    }
}

/// The fields that a bare word of the search text searches. A field prefix
/// works the same in each scope.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Serialize, Deserialize, specta::Type, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SearchScope {
    /// The title, the author names and the series name.
    #[default]
    TitlesAuthorsSeries,
    /// The title, the author names, the series name, the tags, the publisher
    /// and the identifier values.
    AllFields,
}

impl From<SearchScope> for libcalibre::SearchScope {
    fn from(scope: SearchScope) -> Self {
        match scope {
            SearchScope::TitlesAuthorsSeries => libcalibre::SearchScope::TitlesAuthorsSeries,
            SearchScope::AllFields => libcalibre::SearchScope::AllFields,
        }
    }
}

#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Serialize, Deserialize, specta::Type, Clone, Debug)]
pub struct LibraryBookQuery {
    /// Search text in a subset of the Calibre search language, for example
    /// `tags:fantasy`, `and`, `or`, `not` and quoted phrases. `search_scope`
    /// selects the fields of a bare word. `None` or empty text matches all
    /// books.
    pub text: Option<String>,
    /// The fields that a bare word searches. The default is
    /// `titlesAuthorsSeries`.
    #[serde(default)]
    #[cfg_attr(feature = "openapi", schema(default = SearchScope::default))]
    pub search_scope: SearchScope,
    pub author_id: Option<String>,
    pub series_id: Option<i32>,
    pub tag_id: Option<i32>,
    pub publisher_id: Option<i32>,
    pub hide_read: bool,
    pub sort: BookSortOrder,
    /// Page size. `None` returns all matches.
    pub limit: Option<u32>,
    pub offset: u32,
}

#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Serialize, Deserialize, specta::Type, Clone)]
pub struct LibraryBookPage {
    pub items: Vec<LibraryBook>,
    /// Total number of books matching the filters, ignoring limit/offset.
    pub total: u32,
    /// Notes about the search text, for example an unknown field name.
    pub search_hints: Vec<LibrarySearchHint>,
}

/// A note about the search text. A hint does not stop the query. The field
/// `kind` on the wire selects the variant, and each variant has only its own
/// fields.
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LibrarySearchHint {
    /// A word has a prefix that is not a field name. The search treats the
    /// word as text.
    UnknownField {
        /// The prefix that the hint is about, as the user typed it.
        name: String,
        /// The text of the hint for the user.
        message: String,
    },
    /// A hint that this contract does not name yet. A client shows only its
    /// message.
    Other {
        /// The text of the hint for the user.
        message: String,
    },
}

impl From<&libcalibre::SearchHint> for LibrarySearchHint {
    fn from(hint: &libcalibre::SearchHint) -> Self {
        let message = hint.to_string();
        match hint {
            libcalibre::SearchHint::UnknownField { name } => Self::UnknownField {
                name: name.clone(),
                message,
            },
            _ => Self::Other { message },
        }
    }
}

#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Serialize, Deserialize, specta::Type, Clone)]
pub struct LibrarySeries {
    pub id: i32,
    pub name: String,
    pub book_count: u32,
}

#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Serialize, Deserialize, specta::Type, Clone)]
pub struct LibraryTag {
    pub id: i32,
    pub name: String,
    pub book_count: u32,
}

#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Serialize, Deserialize, specta::Type, Clone)]
pub struct LibraryPublisher {
    pub id: i32,
    pub name: String,
    pub book_count: u32,
}
