//! Bringing `citadel.db` up to date when it is opened.
//!
//! A failing run leaves the database as it was. On top of that:
//! - before any pending migration touches an existing database, a consistent
//!   snapshot is written next to it with `VACUUM INTO` (the newest few are kept);
//! - backup and migration run under an exclusive lock on `citadel.db.lock`, so
//!   a second process (the server and the admin CLI, say) waits and then finds
//!   nothing left to do, and pending migrations apply together or not at all;
//! - a database migrated by a newer build, or one whose pending migrations
//!   would apply out of order, is refused rather than guessed at.
use std::path::{Path, PathBuf};

use diesel::{
    migration::{Migration, MigrationSource},
    sql_types::Text,
    sqlite::{Sqlite, SqliteConnection},
    RunQueryDsl,
};
use diesel_migrations::{embed_migrations, EmbeddedMigrations, MigrationHarness};

use super::{restrict_permissions, Result, StoreError};

const MIGRATIONS: EmbeddedMigrations = embed_migrations!("migrations");
const BACKUPS_KEPT: usize = 3;

pub(super) fn migrate(connection: &mut SqliteConnection, path: &Path) -> Result<()> {
    migrate_with(connection, path, &MIGRATIONS)
}

fn migrate_with(
    connection: &mut SqliteConnection,
    path: &Path,
    source: &dyn MigrationSource<Sqlite>,
) -> Result<()> {
    if pending(source, &applied_versions(connection)?)?.is_empty() {
        return Ok(());
    }
    let _lock = lock(path)?;
    // Another process may have migrated while this one waited for the lock.
    let applied = applied_versions(connection)?;
    if pending(source, &applied)?.is_empty() {
        return Ok(());
    }
    let backup = match applied.last() {
        Some(version) => Some(backup(connection, path, version)?),
        None => None,
    };
    let failed = |error: String| {
        StoreError::Storage(match &backup {
            Some(backup) => format!(
                "citadel.db migration failed: {error}. The database was left unchanged; \
                 a copy taken just before migrating is at {}.",
                backup.display()
            ),
            None => format!("citadel.db migration failed: {error}"),
        })
    };
    // One transaction: a run applies every pending migration or none.
    connection.immediate_transaction(|connection| {
        let pending = pending(source, &applied_versions(connection)?)?;
        connection
            .run_migrations(&pending)
            .map(drop)
            .map_err(|error| failed(error.to_string()))
    })
}

/// Serializes backup-and-migrate across processes. SQLite's own write lock
/// can't cover the backup: `VACUUM INTO` refuses to run inside a transaction.
fn lock(path: &Path) -> Result<std::fs::File> {
    let lock_path = path.with_file_name(format!(
        "{}.lock",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("citadel.db")
    ));
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .and_then(|file| file.lock().map(|()| file))
        .map_err(|error| {
            StoreError::Storage(format!(
                "could not lock {} to migrate citadel.db: {error}",
                lock_path.display()
            ))
        })?;
    Ok(file)
}

/// Applied versions, oldest first.
fn applied_versions(connection: &mut SqliteConnection) -> Result<Vec<String>> {
    let mut versions: Vec<String> = connection
        .applied_migrations()
        .map_err(|error| StoreError::Storage(format!("citadel.db migrations: {error}")))?
        .iter()
        .map(ToString::to_string)
        .collect();
    versions.sort();
    Ok(versions)
}

/// Migrations still to run, after refusing histories this build can't apply.
fn pending(
    source: &dyn MigrationSource<Sqlite>,
    applied: &[String],
) -> Result<Vec<Box<dyn Migration<Sqlite>>>> {
    let known = source
        .migrations()
        .map_err(|error| StoreError::Storage(format!("citadel.db migrations: {error}")))?;
    let known_versions: Vec<String> = known
        .iter()
        .map(|migration| migration.name().version().to_string())
        .collect();
    if let Some(unknown) = applied
        .iter()
        .find(|version| !known_versions.contains(version))
    {
        return Err(StoreError::Storage(format!(
            "citadel.db was updated by a newer version of Citadel (migration {unknown}). \
             Update Citadel, or restore a citadel.db backup made by this version."
        )));
    }
    let mut pending: Vec<_> = known
        .into_iter()
        .filter(|migration| !applied.contains(&migration.name().version().to_string()))
        .collect();
    pending.sort_by_key(|migration| migration.name().version().to_string());
    if let (Some(first), Some(latest)) = (pending.first(), applied.last()) {
        let first = first.name().version().to_string();
        if first < *latest {
            return Err(StoreError::Storage(format!(
                "citadel.db migration {first} would run after the newer {latest}; \
                 refusing to apply migrations out of order."
            )));
        }
    }
    Ok(pending)
}

/// Writes a consistent copy of the database, named for the last migration it
/// contains, and prunes older copies.
fn backup(connection: &mut SqliteConnection, path: &Path, version: &str) -> Result<PathBuf> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("citadel.db");
    let prefix = format!("{file_name}.backup-");
    let backup = path.with_file_name(format!("{prefix}{version}"));
    // A copy from an earlier failed attempt holds the same pre-migration state.
    match std::fs::remove_file(&backup) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(backup_error(&backup, error)),
    }
    diesel::sql_query("VACUUM INTO ?")
        .bind::<Text, _>(backup.to_string_lossy())
        .execute(connection)
        .map_err(|error| backup_error(&backup, error))?;
    restrict_permissions(&backup);

    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    let mut backups: Vec<PathBuf> = std::fs::read_dir(directory)
        .map_err(|error| backup_error(&backup, error))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|candidate| {
            candidate
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix))
        })
        .collect();
    backups.sort();
    for old in backups.iter().rev().skip(BACKUPS_KEPT) {
        let _ = std::fs::remove_file(old);
    }
    Ok(backup)
}

fn backup_error(backup: &Path, error: impl std::fmt::Display) -> StoreError {
    StoreError::Storage(format!(
        "could not back up citadel.db to {} before migrating: {error}",
        backup.display()
    ))
}

#[cfg(test)]
mod tests {
    use diesel::{connection::SimpleConnection, Connection};
    use diesel_migrations::FileBasedMigrations;

    use super::*;

    /// A migrations directory with `up` SQL per version, in the given order.
    fn migrations(root: &Path, steps: &[(&str, &str)]) -> FileBasedMigrations {
        let directory = root.join("migrations");
        let _ = std::fs::remove_dir_all(&directory);
        for (version, up) in steps {
            let step = directory.join(format!("{version}_step"));
            std::fs::create_dir_all(&step).unwrap();
            std::fs::write(step.join("up.sql"), up).unwrap();
            std::fs::write(step.join("down.sql"), "SELECT 1;").unwrap();
        }
        FileBasedMigrations::from_path(directory).unwrap()
    }

    fn tables(connection: &mut SqliteConnection) -> Vec<String> {
        #[derive(diesel::QueryableByName)]
        struct Name {
            #[diesel(sql_type = Text)]
            name: String,
        }
        diesel::sql_query(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' ORDER BY name",
        )
        .load::<Name>(connection)
        .unwrap()
        .into_iter()
        .map(|row| row.name)
        .collect()
    }

    fn connect(path: &Path) -> SqliteConnection {
        let mut connection = SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        connection
            .batch_execute("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;")
            .unwrap();
        connection
    }

    const FIRST: (&str, &str) = ("2026-01-01-000000", "CREATE TABLE first (id INTEGER);");
    const SECOND: (&str, &str) = ("2026-02-01-000000", "CREATE TABLE second (id INTEGER);");

    #[test]
    fn a_new_database_migrates_without_a_backup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("citadel.db");
        let source = migrations(directory.path(), &[FIRST, SECOND]);
        migrate_with(&mut connect(&path), &path, &source).unwrap();
        assert_eq!(tables(&mut connect(&path)), ["first", "second"]);
        assert!(!std::fs::read_dir(directory.path())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("backup")));
    }

    #[test]
    fn pending_migrations_back_up_first_and_a_failure_leaves_the_last_good_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("citadel.db");
        migrate_with(
            &mut connect(&path),
            &path,
            &migrations(directory.path(), &[FIRST]),
        )
        .unwrap();

        migrate_with(
            &mut connect(&path),
            &path,
            &migrations(directory.path(), &[FIRST, SECOND]),
        )
        .unwrap();
        let backup = directory.path().join("citadel.db.backup-20260101000000");
        assert_eq!(tables(&mut connect(&backup)), ["first"]);
        assert_eq!(tables(&mut connect(&path)), ["first", "second"]);

        let broken = (
            "2026-03-01-000000",
            "CREATE TABLE third (id INTEGER); CREATE TABLE third (id INTEGER);",
        );
        let error = migrate_with(
            &mut connect(&path),
            &path,
            &migrations(directory.path(), &[FIRST, SECOND, broken]),
        )
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("citadel.db.backup-20260201000000"),
            "{error}"
        );
        assert_eq!(tables(&mut connect(&path)), ["first", "second"]);
        assert_eq!(applied_versions(&mut connect(&path)).unwrap().len(), 2);
    }

    #[test]
    fn only_the_newest_backups_are_kept() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("citadel.db");
        let mut steps = vec![FIRST];
        migrate_with(
            &mut connect(&path),
            &path,
            &migrations(directory.path(), &steps),
        )
        .unwrap();
        let versions = [
            "2026-02-01-000000",
            "2026-03-01-000000",
            "2026-04-01-000000",
            "2026-05-01-000000",
        ];
        let sql: Vec<String> = versions
            .iter()
            .map(|version| format!("CREATE TABLE t{} (id INTEGER);", version.replace('-', "")))
            .collect();
        for (version, up) in versions.iter().zip(&sql) {
            steps.push((version, up));
            migrate_with(
                &mut connect(&path),
                &path,
                &migrations(directory.path(), &steps),
            )
            .unwrap();
        }
        let mut backups: Vec<String> = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("citadel.db.backup-"))
            .collect();
        backups.sort();
        assert_eq!(
            backups,
            [
                "citadel.db.backup-20260201000000",
                "citadel.db.backup-20260301000000",
                "citadel.db.backup-20260401000000",
            ]
        );
    }

    #[test]
    fn newer_or_out_of_order_histories_are_refused() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("citadel.db");
        migrate_with(
            &mut connect(&path),
            &path,
            &migrations(directory.path(), &[FIRST, SECOND]),
        )
        .unwrap();

        let older_build = migrate_with(
            &mut connect(&path),
            &path,
            &migrations(directory.path(), &[FIRST]),
        )
        .unwrap_err()
        .to_string();
        assert!(
            older_build.contains("newer version of Citadel"),
            "{older_build}"
        );

        let late = ("2026-01-15-000000", "CREATE TABLE late (id INTEGER);");
        let out_of_order = migrate_with(
            &mut connect(&path),
            &path,
            &migrations(directory.path(), &[FIRST, late, SECOND]),
        )
        .unwrap_err()
        .to_string();
        assert!(out_of_order.contains("out of order"), "{out_of_order}");
        assert_eq!(tables(&mut connect(&path)), ["first", "second"]);
    }

    #[test]
    fn concurrent_migrators_apply_each_migration_once() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("citadel.db");
        migrate_with(
            &mut connect(&path),
            &path,
            &migrations(directory.path(), &[FIRST]),
        )
        .unwrap();
        migrations(directory.path(), &[FIRST, SECOND]);
        let start = std::sync::Arc::new(std::sync::Barrier::new(2));
        let runs: Vec<_> = (0..2)
            .map(|_| {
                let (path, root, start) = (
                    path.clone(),
                    directory.path().join("migrations"),
                    start.clone(),
                );
                std::thread::spawn(move || {
                    let source = FileBasedMigrations::from_path(root).unwrap();
                    let mut connection = connect(&path);
                    start.wait();
                    migrate_with(&mut connection, &path, &source)
                })
            })
            .collect();
        for run in runs {
            run.join().unwrap().unwrap();
        }
        assert_eq!(applied_versions(&mut connect(&path)).unwrap().len(), 2);
        assert_eq!(tables(&mut connect(&path)), ["first", "second"]);
    }

    #[test]
    fn the_embedded_migrations_apply_to_a_new_database() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("citadel.db");
        migrate(&mut connect(&path), &path).unwrap();
        migrate(&mut connect(&path), &path).unwrap();
        assert!(tables(&mut connect(&path)).contains(&"users".to_string()));
    }
}
