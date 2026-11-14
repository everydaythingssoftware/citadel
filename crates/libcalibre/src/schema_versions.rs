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
//! Every library goes through the same ordered migrations. A new one is
//! created at the version-26 baseline (`sql/v26.sql`) and then migrated
//! step by step, exactly as an existing library is upgraded:
//!
//! - 25 → 26: `link` columns on the category and normalized custom-column
//!   value tables ([`add_link_columns`])
//! - 26 → 27: `sql/v26_to_v27.sql`
//! - 27 → 28: `sql/v27_to_v28.sql`
//!
//! A new schema version adds one migration here and bumps
//! [`SCHEMA_VERSION`]. Migrations create and drop objects outright, without
//! `IF NOT EXISTS`, so a library that isn't at the version it claims fails
//! the upgrade (inside its transaction) rather than being half-migrated.
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

/// The version new libraries start at before migrating to [`SCHEMA_VERSION`].
const BASELINE_VERSION: i32 = 26;
const BASELINE_SQL: &str = include_str!("sql/v26.sql");

/// The migration from each version to the next.
fn migrate_from(conn: &mut SqliteConnection, version: i32) -> Result<(), diesel::result::Error> {
    match version {
        25 => add_link_columns(conn),
        26 => conn.batch_execute(include_str!("sql/v26_to_v27.sql")),
        27 => conn.batch_execute(include_str!("sql/v27_to_v28.sql")),
        _ => unreachable!("every version from the minimum has a migration"),
    }
}

/// Runs each migration from `from` to [`SCHEMA_VERSION`] in order, recording
/// each version reached. The caller holds the transaction.
fn migrate(conn: &mut SqliteConnection, from: i32) -> Result<(), diesel::result::Error> {
    for version in from..SCHEMA_VERSION {
        migrate_from(conn, version)?;
        conn.batch_execute(&format!("PRAGMA user_version = {}", version + 1))?;
    }
    Ok(())
}

/// What [`crate::Library::upgrade`] did.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub struct SchemaUpgrade {
    /// The schema version before the upgrade.
    pub from: i32,
    /// The schema version after it, [`SCHEMA_VERSION`].
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
    conn.exclusive_transaction(|conn| {
        conn.batch_execute(BASELINE_SQL)?;
        conn.batch_execute(&format!("PRAGMA user_version = {BASELINE_VERSION}"))?;
        migrate(conn, BASELINE_VERSION)?;
        sql_query("INSERT INTO library_id (uuid) VALUES (?)")
            .bind::<Text, _>(uuid)
            .execute(conn)?;
        Ok(())
    })
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
    conn.exclusive_transaction(|conn| migrate(conn, from))?;
    Ok(Some(SchemaUpgrade {
        from,
        to: SCHEMA_VERSION,
        backup,
    }))
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

/// Migration 25 → 26: category tables, and normalized custom-column value
/// tables, gain a `link` column. A custom column whose tables are missing
/// (one marked for deletion) is skipped.
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
        if columns_of(conn, &table)?.is_empty() {
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
