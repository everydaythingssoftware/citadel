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

#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Serialize, Deserialize, specta::Type, Clone, Debug)]
pub struct LibraryBookQuery {
    /// Substring match across title, author names, and series names.
    /// `None` or empty text matches all books.
    pub text: Option<String>,
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
