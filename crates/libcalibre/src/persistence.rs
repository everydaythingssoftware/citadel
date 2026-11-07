use diesel::connection::SimpleConnection;
use diesel::prelude::*;

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
#[allow(unused)]
pub fn sort_book_title(title: String) -> String {
    sorting::sort_book_title(&title)
}

/// Converts author name to APA-style sortable format for SQL.
#[allow(unused)]
pub fn sort_author_name(name: String) -> String {
    sorting::sort_author_name_apa(&name)
}

// SQL functions a Calibre library's triggers call. Declared at module scope
// (rather than inside the establishing fn) so they can be registered on any
// connection.
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
/// Triggers are not touched: they are persistent objects in the library's
/// schema, created with it, and a library's own are left as they are.
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
