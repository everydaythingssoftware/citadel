use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[derive(Serialize, specta::Type, Deserialize, Clone)]
pub struct LibraryAuthor {
    pub id: String,
    pub name: String,
    pub sortable_name: String,
    /// Number of books in the library linked to this author, from
    /// `Library::author_book_counts` (one GROUP BY pass over
    /// `books_authors_link`). The Authors page renders this directly
    /// instead of deriving counts from the whole book list.
    pub book_count: u32,
}

impl LibraryAuthor {
    /// Build the DTO from a hydrated author plus the library-wide
    /// `Library::author_book_counts` map (authors absent from the map have
    /// no linked books).
    pub fn from_author(
        author: &libcalibre::Author,
        book_counts: &HashMap<libcalibre::AuthorId, i64>,
    ) -> Self {
        LibraryAuthor {
            id: author.id.as_i32().to_string(),
            name: author.name.clone(),
            sortable_name: author.sort.clone(),
            book_count: book_counts
                .get(&author.id)
                .copied()
                .map(|count| u32::try_from(count).unwrap_or(u32::MAX))
                .unwrap_or(0),
        }
    }
}
