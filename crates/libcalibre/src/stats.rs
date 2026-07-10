use diesel::connection::SimpleConnection;
use diesel::prelude::*;

use crate::error::CalibreError;
use crate::util::ValidDbPath;

/// Headline counts for a library, cheap enough to run against a library the
/// user has only pointed at (onboarding's post-open reveal): two COUNT
/// queries, no book-row hydration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LibraryStats {
    pub book_count: i64,
    pub author_count: i64,
}

/// Count books and authors in the library at `db_path` without adopting it.
///
/// Deliberately NOT [`crate::persistence::establish_connection`]: that flips
/// the journal mode to WAL and re-registers triggers — persistent changes to
/// a database the user has only *pointed at*, not opened. `query_only` turns
/// any accidental write into a hard error; `busy_timeout` tolerates a
/// concurrently running Calibre/Citadel holding the write lock.
pub fn library_stats(db_path: &ValidDbPath) -> Result<LibraryStats, CalibreError> {
    use crate::schema::{authors, books};

    let mut conn =
        SqliteConnection::establish(&db_path.database_path).map_err(CalibreError::database)?;
    conn.batch_execute("PRAGMA query_only = ON; PRAGMA busy_timeout = 3000;")
        .map_err(CalibreError::database)?;

    let book_count = books::table.count().get_result(&mut conn)?;
    let author_count = authors::table.count().get_result(&mut conn)?;

    Ok(LibraryStats {
        book_count,
        author_count,
    })
}
