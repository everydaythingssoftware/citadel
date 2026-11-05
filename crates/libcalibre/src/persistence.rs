use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_query;

use crate::error::CalibreError;
use crate::sorting;

/// Converts book title to sortable format for SQL.
///
/// This function wraps sorting::sort_book_title() to provide the same
/// title sorting logic used throughout the application. It moves leading
/// articles (A, An, The) to the end of the title.
///
/// "Unused" is allowed because this function is called from SQL, and registered
/// with the database connection.
///
/// Based on Calibre's implementation:
/// https://github.com/kovidgoyal/calibre/blob/7f3ccb333d906f5867636dd0dc4700b495e5ae6f/src/calibre/library/database.py#L61C1-L69C54
#[allow(unused)]
pub fn sort_book_title(title: String) -> String {
    sorting::sort_book_title(&title)
}

/// Converts author name to APA-style sortable format for SQL.
///
/// Based on Calibre's implementation:
/// https://github.com/kovidgoyal/calibre/blob/master/src/calibre/ebooks/metadata/__init__.py
#[allow(unused)]
pub fn sort_author_name(name: String) -> String {
    sorting::sort_author_name_apa(&name)
}

/// Registers SQLite triggers for maintaining data integrity.
///
/// This function registers triggers that Calibre uses to:
/// - Auto-generate `sort` and `uuid` fields on book insert
/// - Update `sort` field when book title changes
/// - Cascade delete related records when a book is deleted
///
/// Triggers are registered using "DROP TRIGGER IF EXISTS" for idempotency,
/// so this function can be safely called multiple times.
pub fn register_triggers(conn: &mut SqliteConnection) -> Result<(), diesel::result::Error> {
    // Books insert trigger - auto-generate sort and uuid
    sql_query("DROP TRIGGER IF EXISTS books_insert_trg").execute(conn)?;
    sql_query(
        "CREATE TRIGGER books_insert_trg AFTER INSERT ON books
         BEGIN
             UPDATE books SET sort=title_sort(NEW.title), uuid=uuid4()
             WHERE id=NEW.id;
         END;",
    )
    .execute(conn)?;

    // Books update trigger - update sort when title changes
    sql_query("DROP TRIGGER IF EXISTS books_update_trg").execute(conn)?;
    sql_query(
        "CREATE TRIGGER books_update_trg AFTER UPDATE ON books
         BEGIN
             UPDATE books SET sort=title_sort(NEW.title)
             WHERE id=NEW.id AND OLD.title <> NEW.title;
         END;",
    )
    .execute(conn)?;

    // Books delete trigger - cascade delete related records
    sql_query("DROP TRIGGER IF EXISTS books_delete_trg").execute(conn)?;
    sql_query(
        "CREATE TRIGGER books_delete_trg AFTER DELETE ON books
         BEGIN
             DELETE FROM books_authors_link WHERE book=OLD.id;
             DELETE FROM books_publishers_link WHERE book=OLD.id;
             DELETE FROM books_ratings_link WHERE book=OLD.id;
             DELETE FROM books_series_link WHERE book=OLD.id;
             DELETE FROM books_tags_link WHERE book=OLD.id;
             DELETE FROM books_languages_link WHERE book=OLD.id;
             DELETE FROM data WHERE book=OLD.id;
             DELETE FROM last_read_positions WHERE book=OLD.id;
             DELETE FROM annotations WHERE book=OLD.id;
             DELETE FROM comments WHERE book=OLD.id;
             DELETE FROM conversion_options WHERE book=OLD.id;
             DELETE FROM books_plugin_data WHERE book=OLD.id;
             DELETE FROM identifiers WHERE book=OLD.id;
         END;",
    )
    .execute(conn)?;

    Ok(())
}

// Custom SQL functions Calibre relies on. Declared at module scope (rather than
// inside the establishing fn) so they can be registered on any connection.
// See: https://github.com/kovidgoyal/calibre/blob/7f3ccb333d906f5867636dd0dc4700b495e5ae6f/src/calibre/library/database.py#L55-L70
define_sql_function!(fn title_sort(title: diesel::sql_types::Text) -> diesel::sql_types::Text);
define_sql_function!(fn uuid4() -> diesel::sql_types::Text);
define_sql_function!(fn author_to_author_sort(name: diesel::sql_types::Text) -> diesel::sql_types::Text);

/// Register Calibre's custom SQL functions (`title_sort`, `uuid4`,
/// `author_to_author_sort`) on `conn`. These are per-connection, so they must
/// be registered on every connection.
pub fn register_sql_functions(conn: &mut SqliteConnection) -> Result<(), diesel::result::Error> {
    title_sort_utils::register_impl(conn, sort_book_title)?;
    uuid4_utils::register_impl(conn, || uuid::Uuid::new_v4().to_string())?;
    author_to_author_sort_utils::register_impl(conn, sort_author_name)?;
    Ok(())
}

/// Apply the PRAGMAs libcalibre wants on every SQLite connection.
///
/// Run in order as individual statements: `busy_timeout` goes first so the
/// subsequent WAL switch (which may briefly need a write lock) waits instead of
/// failing with `SQLITE_BUSY`. WAL plus a non-zero busy timeout removes the
/// spurious `SQLITE_BUSY` errors that the DB-write + `metadata.opf`-write pair
/// per book edit can otherwise provoke.
///
/// `foreign_keys = ON` is future-proofing: Calibre's schema (including the
/// custom-column tables) declares no FK constraints today, so enabling
/// enforcement changes nothing for existing libraries.
///
/// On `:memory:` and other temp databases SQLite silently keeps its in-memory
/// journal (reporting `journal_mode` = `memory`); this is not an error.
///
/// NOTE: WAL coordinates concurrent access only between connections **on the
/// same host** (via the `-shm` file). A library on a network/cloud filesystem
/// is unsupported under WAL.
fn apply_pragmas(conn: &mut SqliteConnection) -> Result<(), diesel::result::Error> {
    conn.batch_execute(
        "PRAGMA busy_timeout = 3000;\
         PRAGMA journal_mode = WAL;\
         PRAGMA synchronous = NORMAL;\
         PRAGMA foreign_keys = ON;\
         PRAGMA wal_autocheckpoint = 1000;",
    )
}

/// Per-connection setup: PRAGMAs plus the custom SQL functions. Both are
/// scoped to a single SQLite connection, so every connection needs them.
///
/// Triggers are deliberately NOT registered here: they are persistent database
/// objects (stored in `sqlite_master`), and re-running their DROP/CREATE DDL
/// from every connection would serialize on the write lock and open a window
/// where a concurrent insert fires no trigger. [`establish_connection`]
/// registers them once per writable connection instead.
///
/// Function registration is best-effort (matching the historical behaviour);
/// PRAGMA failures propagate.
fn prepare_connection(conn: &mut SqliteConnection) -> Result<(), diesel::result::Error> {
    apply_pragmas(conn)?;

    // Register SQL function implementations. Ignore any errors.
    let _ = register_sql_functions(conn);

    Ok(())
}

pub fn establish_connection(
    db_path: impl AsRef<std::path::Path>,
) -> Result<SqliteConnection, CalibreError> {
    let db_path = db_path
        .as_ref()
        .to_str()
        .ok_or_else(|| CalibreError::NonUtf8Path(db_path.as_ref().to_path_buf()))?;
    let mut connection = SqliteConnection::establish(db_path).map_err(CalibreError::database)?;
    prepare_connection(&mut connection)?;

    // Register triggers for data integrity and automatic field generation.
    // Best-effort: a fresh or non-Calibre database may lack the `books` table
    // the triggers attach to, and that must not fail opening the connection.
    register_triggers(&mut connection)
        .map_err(|e| eprintln!("Failed to register triggers: {}", e))
        .ok();

    Ok(connection)
}

/// Open an existing database without changing its journal mode or schema.
/// SQLite enforces read-only access while retaining normal locking and live WAL reads.
pub fn establish_read_only_connection(
    db_path: impl AsRef<std::path::Path>,
) -> Result<SqliteConnection, CalibreError> {
    let path = db_path.as_ref();
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(CalibreError::database)?
            .join(path)
    };
    let path = path.to_string_lossy();
    #[cfg(windows)]
    let path = path.replace('\\', "/");
    let mut uri = String::from("file:");
    if !path.starts_with('/') {
        uri.push('/');
    }
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~:".contains(&byte) {
            uri.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(uri, "%{byte:02X}").expect("writing to a string cannot fail");
        }
    }
    uri.push_str("?mode=ro");
    let mut connection = SqliteConnection::establish(&uri).map_err(CalibreError::database)?;
    connection.batch_execute("PRAGMA query_only = ON; PRAGMA busy_timeout = 3000;")?;
    register_sql_functions(&mut connection)?;
    Ok(connection)
}
