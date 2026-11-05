use diesel::{prelude::*, sql_query, sql_types::BigInt};
use libcalibre::{__internals::establish_read_only_connection, Library};

#[derive(QueryableByName)]
struct Count {
    #[diesel(sql_type = BigInt)]
    count: i64,
}

fn count(conn: &mut SqliteConnection) -> i64 {
    sql_query("SELECT count(*) AS count FROM probe")
        .get_result::<Count>(conn)
        .unwrap()
        .count
}

#[test]
fn read_only_open_preserves_database_and_handles_uri_characters() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("library #?% é");
    std::fs::create_dir(&directory).unwrap();
    let path = directory.join("metadata.db");
    drop(Library::create_library_at(directory.to_str().unwrap()).unwrap());
    let before = std::fs::read(&path).unwrap();
    let mut permissions = std::fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&path, permissions).unwrap();
    {
        let mut library = Library::open_read_only(directory).unwrap();
        assert!(!library.library_uuid().unwrap().is_empty());
        assert!(!library.get_book_read_state(libcalibre::BookId(1)).unwrap());
        assert!(library
            .batch_get_read_states(&[libcalibre::BookId(1)])
            .unwrap()
            .is_empty());
        let mut connection = establish_read_only_connection(path.to_str().unwrap()).unwrap();
        assert!(sql_query("CREATE TABLE accidental_write (id INTEGER)")
            .execute(&mut connection)
            .is_err());
    }
    assert_eq!(std::fs::read(&path).unwrap(), before);
    #[cfg(windows)]
    {
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        std::fs::set_permissions(&path, permissions).unwrap();
    }
}

#[test]
fn read_only_open_observes_live_wal_commits() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("metadata.db");
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer
        .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE probe (id INTEGER);")
        .unwrap();
    let mut reader = establish_read_only_connection(path.to_str().unwrap()).unwrap();
    assert_eq!(count(&mut reader), 0);
    writer.execute("INSERT INTO probe VALUES (1)", []).unwrap();
    assert_eq!(count(&mut reader), 1);
    assert!(sql_query("INSERT INTO probe VALUES (2)")
        .execute(&mut reader)
        .is_err());
}

#[test]
fn read_only_open_does_not_create_missing_database() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("missing.db");
    assert!(establish_read_only_connection(path.to_str().unwrap()).is_err());
    assert!(!path.exists());
}
