// Tests for connection PRAGMAs (WAL + busy_timeout, ...), the r2d2 pool paths,
// and multi-connection contention behaviour.
// See CDL-18: libcalibre must enable WAL + busy_timeout on every connection and
// offer pooled paths whose connections carry the same setup (custom SQL
// functions + PRAGMAs, with triggers registered once per database) the single
// owned connection does.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use diesel::connection::SimpleConnection;
use diesel::prelude::*;
use diesel::sql_query;
use diesel::sql_types::{Integer, Text};
use libcalibre::persistence::{
    create_read_pool, create_write_pool, establish_connection, retry_on_busy,
};

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
// Pools
// =============================================================================

/// A connection obtained from the write pool has the PRAGMAs applied and the
/// custom SQL functions + triggers registered — the same setup as the
/// single-conn path.
#[test]
fn write_pool_connection_has_pragmas_functions_and_triggers() {
    let (_temp, db_path) = fixture_db();
    let pool = create_write_pool(db_path.to_str().unwrap()).unwrap();
    let mut conn = pool.get().unwrap();

    // PRAGMAs applied on checkout.
    assert_eq!(journal_mode(&mut conn), "wal");
    assert_eq!(busy_timeout(&mut conn), 3000);

    // Custom SQL function registered and callable.
    let sorted: TextResult = sql_query("SELECT title_sort('The Great Book') AS result")
        .get_result(&mut conn)
        .unwrap();
    assert_eq!(sorted.result, "Great Book, The");

    // Triggers registered against the real `books` table.
    let triggers: CountResult = sql_query(
        "SELECT COUNT(*) AS count FROM sqlite_master \
         WHERE type = 'trigger' \
         AND name IN ('books_insert_trg', 'books_update_trg', 'books_delete_trg')",
    )
    .get_result(&mut conn)
    .unwrap();
    assert_eq!(triggers.count, 3);
}

/// End-to-end check that the pooled connection's trigger + functions cooperate:
/// inserting a bare book row fires `books_insert_trg`, which calls the
/// registered `title_sort()` and `uuid4()` functions to populate `sort`/`uuid`.
#[test]
fn write_pool_insert_trigger_populates_sort_and_uuid() {
    let (_temp, db_path) = fixture_db();
    let pool = create_write_pool(db_path.to_str().unwrap()).unwrap();
    let mut conn = pool.get().unwrap();

    sql_query("INSERT INTO books (title) VALUES ('The Hobbit')")
        .execute(&mut conn)
        .unwrap();

    #[derive(QueryableByName)]
    struct BookRow {
        #[diesel(sql_type = Text)]
        sort: String,
        #[diesel(sql_type = Text)]
        uuid: String,
    }

    let row: BookRow = sql_query("SELECT sort, uuid FROM books WHERE title = 'The Hobbit'")
        .get_result(&mut conn)
        .unwrap();

    assert_eq!(row.sort, "Hobbit, The");
    assert_eq!(row.uuid.len(), 36, "uuid4() should produce a 36-char UUID");
}

/// The write pool holds exactly one connection — SQLite has one write lock,
/// and a multi-writer pool would only queue on it.
#[test]
fn write_pool_is_single_connection() {
    let (_temp, db_path) = fixture_db();
    let pool = create_write_pool(db_path.to_str().unwrap()).unwrap();
    assert_eq!(pool.max_size(), 1);
}

/// Read-pool connections have the PRAGMAs + functions, can read, but writing
/// through them is a hard error (`PRAGMA query_only`), not a convention.
#[test]
fn read_pool_connection_reads_but_cannot_write() {
    let (_temp, db_path) = fixture_db();
    let pool = create_read_pool(db_path.to_str().unwrap(), 2).unwrap();
    let mut conn = pool.get().unwrap();

    assert_eq!(journal_mode(&mut conn), "wal");
    assert_eq!(busy_timeout(&mut conn), 3000);

    // Functions are registered — read queries may call them too.
    let sorted: TextResult = sql_query("SELECT title_sort('A Study in Scarlet') AS result")
        .get_result(&mut conn)
        .unwrap();
    assert_eq!(sorted.result, "Study in Scarlet, A");

    // Reads work.
    assert_eq!(book_count(&mut conn), 0);

    // Writes are rejected.
    let write_attempt = sql_query("INSERT INTO books (title) VALUES ('Nope')").execute(&mut conn);
    let message = write_attempt.unwrap_err().to_string();
    assert!(
        message.contains("readonly"),
        "expected a readonly-database error, got {message:?}"
    );
}

// =============================================================================
// Multi-connection contention
// =============================================================================

/// Readers are not blocked by an in-flight write transaction: while the write
/// pool's connection holds an open IMMEDIATE transaction with an uncommitted
/// insert, a read-pool connection still reads (and sees the pre-transaction
/// snapshot). After commit, a fresh read sees the new row.
#[test]
fn reader_is_not_blocked_by_open_write_transaction() {
    let (_temp, db_path) = fixture_db();
    let db_path_str = db_path.to_str().unwrap();
    let write_pool = create_write_pool(db_path_str).unwrap();
    let read_pool = create_read_pool(db_path_str, 1).unwrap();

    let mut writer = write_pool.get().unwrap();
    writer
        .immediate_transaction::<_, diesel::result::Error, _>(|conn| {
            sql_query("INSERT INTO books (title) VALUES ('Uncommitted')").execute(conn)?;

            // Mid-transaction: a reader on another connection is neither
            // blocked nor shown the uncommitted row.
            let mut reader = read_pool.get().unwrap();
            assert_eq!(book_count(&mut reader), 0);

            Ok(())
        })
        .unwrap();

    let mut reader = read_pool.get().unwrap();
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

/// `retry_on_busy` re-runs an operation that hits the write lock until it
/// succeeds. Uses a zero busy_timeout so every attempt fails fast while the
/// lock is held, making the retry loop (not the timeout) do the work.
#[test]
fn retry_on_busy_retries_until_lock_is_released() {
    let (_temp, db_path) = fixture_db();
    let db_path_str = db_path.to_str().unwrap().to_string();

    // Opened before the lock is taken — see the busy_timeout test for why.
    let mut conn = establish_connection(&db_path_str).unwrap();
    conn.batch_execute("PRAGMA busy_timeout = 0").unwrap();

    let (lock_held, lock_held_rx) = mpsc::channel();
    let holder = std::thread::spawn({
        let db_path_str = db_path_str.clone();
        move || {
            let mut conn = establish_connection(&db_path_str).unwrap();
            conn.immediate_transaction::<_, diesel::result::Error, _>(|conn| {
                sql_query("INSERT INTO books (title) VALUES ('Held Lock')").execute(conn)?;
                lock_held.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(200));
                Ok(())
            })
            .unwrap();
        }
    });

    lock_held_rx.recv().unwrap();

    let mut attempts = 0;
    retry_on_busy(100, || {
        attempts += 1;
        conn.immediate_transaction::<_, diesel::result::Error, _>(|conn| {
            sql_query("INSERT INTO books (title) VALUES ('Retried')").execute(conn)?;
            Ok(())
        })
    })
    .unwrap();

    assert!(
        attempts > 1,
        "lock was held ~200ms with no busy_timeout; the first attempt(s) must have failed"
    );

    holder.join().unwrap();
    assert_eq!(book_count(&mut conn), 2, "Held Lock + Retried rows");
}

/// Non-busy errors propagate immediately instead of being retried.
#[test]
fn retry_on_busy_does_not_retry_real_errors() {
    let (_temp, db_path) = fixture_db();
    let mut conn = establish_connection(db_path.to_str().unwrap()).unwrap();

    let mut attempts = 0;
    let result = retry_on_busy(5, || {
        attempts += 1;
        sql_query("SELECT * FROM no_such_table").execute(&mut conn)
    });

    assert!(result.is_err());
    assert_eq!(attempts, 1, "a non-busy error must not be retried");
}
