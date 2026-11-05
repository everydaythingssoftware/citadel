// Tests for connection PRAGMAs (WAL + busy_timeout, ...) and multi-connection
// contention behaviour. See CDL-18: libcalibre must enable WAL + busy_timeout
// on every connection.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{Integer, Text};
use libcalibre::__internals::{establish_connection, establish_read_only_connection};

#[derive(QueryableByName)]
struct JournalMode {
    #[diesel(sql_type = Text)]
    journal_mode: String,
}

#[derive(QueryableByName)]
struct BusyTimeout {
    #[diesel(sql_type = Integer)]
    timeout: i32,
}

#[derive(QueryableByName)]
struct TextResult {
    #[diesel(sql_type = Text)]
    result: String,
}

#[derive(QueryableByName)]
struct CountResult {
    #[diesel(sql_type = Integer)]
    count: i32,
}

fn journal_mode(conn: &mut SqliteConnection) -> String {
    sql_query("PRAGMA journal_mode")
        .get_result::<JournalMode>(conn)
        .unwrap()
        .journal_mode
        .to_lowercase()
}

fn busy_timeout(conn: &mut SqliteConnection) -> i32 {
    sql_query("PRAGMA busy_timeout")
        .get_result::<BusyTimeout>(conn)
        .unwrap()
        .timeout
}

fn book_count(conn: &mut SqliteConnection) -> i32 {
    sql_query("SELECT COUNT(*) AS count FROM books")
        .get_result::<CountResult>(conn)
        .unwrap()
        .count
}

/// Copy the empty Calibre library fixture (a real Calibre `metadata.db`, with
/// the `books` table the triggers attach to) into a temp dir and return its
/// path. The `TempDir` is returned so the caller keeps it alive.
fn fixture_db() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    drop(libcalibre::Library::create_library_at(temp.path().to_str().unwrap()).unwrap());
    let db_path = temp.path().join("metadata.db");
    (temp, db_path)
}

// =============================================================================
// PRAGMAs on the single-connection path
// =============================================================================

/// A new file-backed connection reports WAL journal mode + a non-zero busy
/// timeout, and the `-wal`/`-shm` sidecar files appear next to `metadata.db`.
#[test]
fn establish_connection_enables_wal_and_busy_timeout() {
    let (_temp, db_path) = fixture_db();
    let db_path_str = db_path.to_str().unwrap();

    let mut conn = establish_connection(db_path_str).unwrap();

    assert_eq!(journal_mode(&mut conn), "wal");
    assert_eq!(busy_timeout(&mut conn), 3000);

    // WAL sidecar files exist alongside the database while a connection is open.
    let wal = PathBuf::from(format!("{db_path_str}-wal"));
    let shm = PathBuf::from(format!("{db_path_str}-shm"));
    assert!(wal.exists(), "expected WAL file at {wal:?}");
    assert!(shm.exists(), "expected shared-memory file at {shm:?}");
}

/// In-memory databases can't use WAL; the PRAGMA must not error, it just leaves
/// the journal mode as `memory`. (The existing `:memory:` tests rely on this.)
#[test]
fn establish_connection_on_memory_db_does_not_error() {
    let mut conn = establish_connection(":memory:").unwrap();
    // SQLite keeps the in-memory journal rather than switching to WAL.
    assert_eq!(journal_mode(&mut conn), "memory");
    assert_eq!(busy_timeout(&mut conn), 3000);
}

/// The connection error is surfaced, not swallowed into `()`.
#[test]
fn establish_connection_reports_the_underlying_error() {
    let Err(error) = establish_connection("/nonexistent-dir/metadata.db") else {
        panic!("opening a database in a nonexistent directory must fail");
    };
    let message = error.to_string();
    assert!(
        message.to_lowercase().contains("unable to open"),
        "expected SQLite's open error in {message:?}"
    );
}

// =============================================================================
// Multi-connection contention
// =============================================================================

/// Readers are not blocked by an in-flight write transaction: while the
/// writer holds an open IMMEDIATE transaction with an uncommitted insert, a
/// read-only connection still reads (and sees the pre-transaction snapshot).
/// After commit, a fresh read sees the new row.
#[test]
fn reader_is_not_blocked_by_open_write_transaction() {
    let (_temp, db_path) = fixture_db();
    let db_path_str = db_path.to_str().unwrap();
    let mut writer = establish_connection(db_path_str).unwrap();

    writer
        .immediate_transaction::<_, diesel::result::Error, _>(|conn| {
            sql_query("INSERT INTO books (title) VALUES ('Uncommitted')").execute(conn)?;

            // Mid-transaction: a reader on another connection is neither
            // blocked nor shown the uncommitted row.
            let mut reader = establish_read_only_connection(db_path_str).unwrap();
            assert_eq!(book_count(&mut reader), 0);

            Ok(())
        })
        .unwrap();

    let mut reader = establish_read_only_connection(db_path_str).unwrap();
    assert_eq!(book_count(&mut reader), 1);
}

/// `busy_timeout` is what turns concurrent writers from instant SQLITE_BUSY
/// failures into short waits. One thread holds the write lock for ~300ms; a
/// second writer with the default 3000ms timeout succeeds, while a control
/// connection with the timeout zeroed fails immediately.
#[test]
fn busy_timeout_lets_second_writer_wait_out_the_lock() {
    let (_temp, db_path) = fixture_db();
    let db_path_str = db_path.to_str().unwrap().to_string();

    // Open the contending connections BEFORE the lock is taken:
    // establish_connection itself writes (trigger DDL), so opening one while
    // the lock is held would just wait out the holder via busy_timeout and
    // leave nothing to contend with.
    let mut impatient = establish_connection(&db_path_str).unwrap();
    impatient.batch_execute("PRAGMA busy_timeout = 0").unwrap();
    let mut patient = establish_connection(&db_path_str).unwrap();

    // `lock_held` fires once the background thread owns the write lock;
    // the thread then keeps it for ~300ms before committing.
    let (lock_held, lock_held_rx) = mpsc::channel();
    let holder = std::thread::spawn({
        let db_path_str = db_path_str.clone();
        move || {
            let mut conn = establish_connection(&db_path_str).unwrap();
            conn.immediate_transaction::<_, diesel::result::Error, _>(|conn| {
                sql_query("INSERT INTO books (title) VALUES ('Held Lock')").execute(conn)?;
                lock_held.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(300));
                Ok(())
            })
            .unwrap();
        }
    });

    lock_held_rx.recv().unwrap();

    // Control: with busy_timeout disabled, the second writer fails immediately
    // instead of waiting — proving the lock really is held and that it's the
    // busy_timeout PRAGMA doing the work in the assertion below.
    let failure = impatient
        .immediate_transaction::<_, diesel::result::Error, _>(|conn| {
            sql_query("INSERT INTO books (title) VALUES ('Impatient')").execute(conn)?;
            Ok(())
        })
        .unwrap_err();
    assert!(
        failure.to_string().contains("locked"),
        "expected a database-locked error, got {failure:?}"
    );

    // With the default 3000ms busy_timeout, the same write waits out the
    // ~300ms lock and succeeds.
    patient
        .immediate_transaction::<_, diesel::result::Error, _>(|conn| {
            sql_query("INSERT INTO books (title) VALUES ('Patient')").execute(conn)?;
            Ok(())
        })
        .unwrap();

    holder.join().unwrap();

    let mut conn = establish_connection(&db_path_str).unwrap();
    assert_eq!(book_count(&mut conn), 2, "Held Lock + Patient rows");
}
