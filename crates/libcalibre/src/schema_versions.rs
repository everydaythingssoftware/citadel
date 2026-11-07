//! `metadata.db` schema versions: the version a new library is created at,
//! and moving older libraries forward to it.
//!
//! The version lives in `PRAGMA user_version`. libcalibre supports a window:
//! a library below [`MINIMUM_SCHEMA_VERSION`] is refused with advice to open
//! it in Calibre once, and anything from there up opens unmodified, since
//! libcalibre reads nothing later versions add. Nothing upgrades on open;
//! hosts call [`crate::Library::upgrade`] when the person agrees, and a
//! backup of the database is written first.
//!
//! `sql/schema.sql` describes the current schema and is idempotent, so the
//! same script creates a library and brings an older one up to date.
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use diesel::{
    connection::SimpleConnection, prelude::*, sql_query, sql_types::Integer, sql_types::Text,
    SqliteConnection,
};

use crate::{error::CalibreError, util::ValidDbPath};

/// The version current Calibre writes, and new libraries are created at.
pub const SCHEMA_VERSION: i32 = 28;
/// The oldest version Citadel opens: anything Calibre has written since 2021.
pub const MINIMUM_SCHEMA_VERSION: i32 = 25;

const BACKUPS_KEPT: usize = 3;
const BACKUP_INFIX: &str = ".backup-";
const PARTIAL_SUFFIX: &str = ".partial";

const SCHEMA_SQL: &str = include_str!("sql/schema.sql");
/// `application_id` of a Calibre library: "cali" in ASCII.
const APPLICATION_ID: i32 = 0x6361_6c69;
/// `books` columns that versions before 27 had and current libraries drop.
const RETIRED_BOOK_COLUMNS: [&str; 3] = ["flags", "isbn", "lccn"];

/// What [`crate::Library::upgrade`] did.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub struct SchemaUpgrade {
    pub from: i32,
    pub to: i32,
    /// The copy of `metadata.db` taken before the first step ran.
    pub backup: PathBuf,
}

#[derive(QueryableByName)]
struct UserVersion {
    #[diesel(sql_type = Integer)]
    user_version: i32,
}

#[derive(QueryableByName)]
struct ColumnName {
    #[diesel(sql_type = Text)]
    name: String,
}

#[derive(QueryableByName)]
struct ColumnId {
    #[diesel(sql_type = Integer)]
    id: i32,
}

/// The database's `PRAGMA user_version`.
pub(crate) fn schema_version(conn: &mut SqliteConnection) -> Result<i32, diesel::result::Error> {
    sql_query("PRAGMA user_version")
        .get_result::<UserVersion>(conn)
        .map(|row| row.user_version)
}

/// Reads the version of a database the person has only pointed at, through
/// a read-only connection that changes nothing (see [`crate::library_stats`]).
pub fn peek_schema_version(library_root: impl AsRef<Path>) -> Result<i32, CalibreError> {
    let db_path = ValidDbPath::locate(library_root.as_ref())?;
    let mut conn =
        SqliteConnection::establish(&db_path.database_path).map_err(CalibreError::database)?;
    conn.batch_execute("PRAGMA query_only = ON; PRAGMA busy_timeout = 3000;")
        .map_err(CalibreError::database)?;
    Ok(schema_version(&mut conn)?)
}

/// The schema version, or why this build won't open the database.
pub(crate) fn supported_version(conn: &mut SqliteConnection) -> Result<i32, CalibreError> {
    let version = schema_version(conn)?;
    if version == 0 {
        return Err(CalibreError::DatabaseIntegrity(
            "metadata.db is not a Calibre database".to_string(),
        ));
    }
    if version < MINIMUM_SCHEMA_VERSION {
        return Err(CalibreError::UnsupportedSchema {
            version,
            minimum: MINIMUM_SCHEMA_VERSION,
        });
    }
    Ok(version)
}

/// Fills an empty database with the current schema and the library's
/// identity row.
pub(crate) fn create(conn: &mut SqliteConnection, uuid: &str) -> Result<(), diesel::result::Error> {
    conn.batch_execute(SCHEMA_SQL)?;
    stamp_current(conn)?;
    sql_query("INSERT INTO library_id (uuid) VALUES (?)")
        .bind::<Text, _>(uuid)
        .execute(conn)?;
    Ok(())
}

/// Brings the library up to [`SCHEMA_VERSION`] in one exclusive transaction
/// after backing the database up. `None` when the library is already
/// current, in which case nothing is written.
pub(crate) fn upgrade(
    conn: &mut SqliteConnection,
    database_path: &Path,
) -> Result<Option<SchemaUpgrade>, CalibreError> {
    let from = supported_version(conn)?;
    if from >= SCHEMA_VERSION {
        return Ok(None);
    }
    let backup = backup(conn, database_path, from)?;
    conn.exclusive_transaction(|conn| {
        add_link_columns(conn)?;
        conn.batch_execute(SCHEMA_SQL)?;
        sql_query(
            "INSERT OR IGNORE INTO books_pages_link (book, needs_scan) SELECT id, 1 FROM books",
        )
        .execute(conn)?;
        let columns = columns_of(conn, "books")?;
        for column in RETIRED_BOOK_COLUMNS {
            if columns.iter().any(|existing| existing == column) {
                conn.batch_execute(&format!("ALTER TABLE books DROP COLUMN {column}"))?;
            }
        }
        stamp_current(conn)
    })?;
    Ok(Some(SchemaUpgrade {
        from,
        to: SCHEMA_VERSION,
        backup,
    }))
}

fn stamp_current(conn: &mut SqliteConnection) -> Result<(), diesel::result::Error> {
    conn.batch_execute(&format!(
        "PRAGMA application_id = {APPLICATION_ID}; PRAGMA user_version = {SCHEMA_VERSION};"
    ))
}

fn columns_of(
    conn: &mut SqliteConnection,
    table: &str,
) -> Result<Vec<String>, diesel::result::Error> {
    Ok(sql_query("SELECT name FROM pragma_table_info(?)")
        .bind::<Text, _>(table)
        .load::<ColumnName>(conn)?
        .into_iter()
        .map(|column| column.name)
        .collect())
}

/// Version 26 gave category tables, and normalized custom-column value
/// tables, a `link` column. Each is skipped when its table is missing or
/// already has one.
fn add_link_columns(conn: &mut SqliteConnection) -> Result<(), diesel::result::Error> {
    let mut tables: Vec<String> = sql_query("SELECT id FROM custom_columns WHERE normalized")
        .load::<ColumnId>(conn)?
        .into_iter()
        .map(|column| format!("custom_column_{}", column.id))
        .collect();
    tables.extend(
        ["publishers", "series", "tags", "languages", "ratings"]
            .into_iter()
            .map(String::from),
    );
    for table in tables {
        let columns = columns_of(conn, &table)?;
        if columns.is_empty() || columns.iter().any(|column| column == "link") {
            continue;
        }
        conn.batch_execute(&format!(
            "ALTER TABLE {table} ADD COLUMN link TEXT NOT NULL DEFAULT ''"
        ))?;
    }
    Ok(())
}

/// Writes `metadata.db.backup-<version>-<unix time>` beside the database with
/// `VACUUM INTO`, under a temporary name first so a backup that exists is
/// complete, and keeps only the newest few.
fn backup(
    conn: &mut SqliteConnection,
    database_path: &Path,
    version: i32,
) -> Result<PathBuf, CalibreError> {
    let mut taken_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Two upgrades within a second must not overwrite each other's copy.
    while sidecar(database_path, &format!("{version}-{taken_at}")).exists() {
        taken_at += 1;
    }
    let target = sidecar(database_path, &format!("{version}-{taken_at}"));
    let partial = target.with_file_name(format!(
        "{}{PARTIAL_SUFFIX}",
        target.file_name().unwrap_or_default().to_string_lossy()
    ));
    for stale in backups_matching(database_path, |name| name.ends_with(PARTIAL_SUFFIX))? {
        std::fs::remove_file(stale)?;
    }
    sql_query("VACUUM INTO ?")
        .bind::<Text, _>(partial.to_string_lossy())
        .execute(conn)?;
    std::fs::rename(&partial, &target)?;
    for old in backups(database_path)?.into_iter().skip(BACKUPS_KEPT) {
        let _ = std::fs::remove_file(old);
    }
    Ok(target)
}

/// Complete backups beside `database_path`, newest first.
pub fn backups(database_path: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut found = backups_matching(database_path, |name| !name.ends_with(PARTIAL_SUFFIX))?
        .into_iter()
        .map(|path| {
            let order = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.rsplit_once('-'))
                .and_then(|(_, taken_at)| taken_at.parse::<u64>().ok())
                .unwrap_or_default();
            (order, path)
        })
        .collect::<Vec<_>>();
    found.sort_by_key(|(taken_at, _)| std::cmp::Reverse(*taken_at));
    Ok(found.into_iter().map(|(_, path)| path).collect())
}

fn sidecar(database_path: &Path, name: &str) -> PathBuf {
    database_path.with_file_name(format!(
        "{}{BACKUP_INFIX}{name}",
        database_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
    ))
}

fn backups_matching(
    database_path: &Path,
    keep: impl Fn(&str) -> bool,
) -> std::io::Result<Vec<PathBuf>> {
    let prefix = format!(
        "{}{BACKUP_INFIX}",
        database_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
    );
    let directory = database_path.parent().unwrap_or_else(|| Path::new("."));
    let mut found = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&prefix) && keep(name))
        {
            found.push(path);
        }
    }
    Ok(found)
}
