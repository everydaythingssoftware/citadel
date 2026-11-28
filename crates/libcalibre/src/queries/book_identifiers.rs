//! Book identifiers queries
//!
//! Provides functions to interact with `identifiers` in the Calibre database.
//! All functions use type-safe IDs and accept a mutable SQLite connection.

use std::collections::HashMap;

use diesel::prelude::*;
use diesel::{QueryDsl, RunQueryDsl, SqliteConnection};

use crate::models::Identifier;
use crate::{types::BookId, CalibreError};

pub(crate) fn get(
    conn: &mut SqliteConnection,
    book_id: BookId,
) -> Result<Vec<Identifier>, CalibreError> {
    use crate::schema::identifiers::dsl::*;

    identifiers
        .filter(book.eq(book_id.as_i32()))
        .select(Identifier::as_returning())
        .load(conn)
        .map_err(CalibreError::from)
}

// =============================================================================
// Relationships
// =============================================================================

pub(crate) fn find_many_by_book_ids(
    conn: &mut SqliteConnection,
    book_ids: Vec<BookId>,
) -> Result<HashMap<BookId, Vec<Identifier>>, CalibreError> {
    use crate::schema::identifiers::dsl::*;

    let ids: Vec<i32> = book_ids.iter().map(|bid| bid.as_i32()).collect();

    let idents = identifiers
        .filter(book.eq_any(ids))
        .select(Identifier::as_returning())
        .load(conn)
        .map_err(CalibreError::from);

    let mut grouped: HashMap<BookId, Vec<Identifier>> = HashMap::new();
    for ident in idents? {
        grouped.entry(BookId(ident.book)).or_default().push(ident)
    }

    Ok(grouped)
}
