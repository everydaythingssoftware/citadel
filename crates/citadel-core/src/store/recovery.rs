//! Getting a host past a `citadel.db` that [`CitadelStore::open`] refused with
//! [`StoreError::Unusable`]. Each step runs under the migration lock and must
//! be called while no store is open on the file. Nothing here deletes a
//! database: a refused file is moved aside, where it can still be inspected
//! or recovered by hand.
use std::{
    path::{Path, PathBuf},
    time::SystemTime,
};

use super::{
    migrations::{self, BACKUP_SUFFIX},
    restrict_permissions, sidecar, unix_now, CitadelStore, Result, StoreError,
};

/// A pre-migration copy written by [`migrations`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Backup {
    pub path: PathBuf,
    /// The last migration the copy contains.
    pub version: String,
    pub modified: Option<SystemTime>,
}

impl CitadelStore {
    /// Backups next to `path` that this build can open, newest first.
    pub fn backups(path: &Path) -> Result<Vec<Backup>> {
        let known = migrations::known_versions()?;
        let mut backups: Vec<Backup> = migrations::backup_paths(path)
            .map_err(|error| recovery_error(path, error))?
            .into_iter()
            .filter_map(|backup| {
                let version = backup
                    .file_name()?
                    .to_str()?
                    .rsplit_once(BACKUP_SUFFIX)?
                    .1
                    .to_string();
                known.contains(&version).then(|| Backup {
                    modified: std::fs::metadata(&backup)
                        .and_then(|metadata| metadata.modified())
                        .ok(),
                    path: backup,
                    version,
                })
            })
            .collect();
        backups.sort_by(|a, b| b.version.cmp(&a.version));
        Ok(backups)
    }

    /// Moves the database and its WAL files aside, so the next open starts
    /// from an empty database. Returns where the database went.
    pub fn set_aside(path: &Path) -> Result<PathBuf> {
        let _lock = migrations::lock(path)?;
        set_aside_locked(path)
    }

    /// Sets the database aside and puts a copy of `backup` in its place.
    /// Returns where the replaced database went.
    pub fn restore_backup(path: &Path, backup: &Path) -> Result<PathBuf> {
        let _lock = migrations::lock(path)?;
        let restoring = sidecar(path, "restoring");
        std::fs::copy(backup, &restoring).map_err(|error| {
            StoreError::Storage(format!(
                "could not copy {} to restore citadel.db: {error}",
                backup.display()
            ))
        })?;
        restrict_permissions(&restoring);
        let aside = set_aside_locked(path)?;
        std::fs::rename(&restoring, path).map_err(|error| recovery_error(path, error))?;
        Ok(aside)
    }

    /// Forgets interrupted migration runs, so the next open tries again.
    pub fn retry_migration(path: &Path) -> Result<()> {
        let _lock = migrations::lock(path)?;
        migrations::remove_marker(&sidecar(path, "migrating"))
    }
}

fn set_aside_locked(path: &Path) -> Result<PathBuf> {
    let stamp = unix_now();
    let aside = (0..)
        .map(|n| match n {
            0 => sidecar(path, &format!("unusable-{stamp}")),
            n => sidecar(path, &format!("unusable-{stamp}-{n}")),
        })
        .find(|candidate| !candidate.exists())
        .expect("an unused name");
    for suffix in ["", "-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{suffix}", path.display()));
        let to = PathBuf::from(format!("{}{suffix}", aside.display()));
        match std::fs::rename(&from, &to) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(recovery_error(path, error)),
        }
    }
    migrations::remove_marker(&sidecar(path, "migrating"))?;
    Ok(aside)
}

fn recovery_error(path: &Path, error: impl std::fmt::Display) -> StoreError {
    StoreError::Storage(format!("could not recover {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::OpenFailure;

    fn open(path: &Path) -> CitadelStore {
        CitadelStore::open(path).unwrap()
    }

    fn snapshot(path: &Path, to: &Path) {
        use diesel::{Connection, RunQueryDsl};
        let mut connection = diesel::SqliteConnection::establish(path.to_str().unwrap()).unwrap();
        diesel::sql_query("VACUUM INTO ?")
            .bind::<diesel::sql_types::Text, _>(to.to_string_lossy())
            .execute(&mut connection)
            .unwrap();
    }

    #[test]
    fn a_damaged_file_is_refused_and_can_be_set_aside() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("citadel.db");
        std::fs::write(
            &path,
            b"not sqlite, just bytes that are long enough to look like a header",
        )
        .unwrap();
        let Err(StoreError::Unusable { failure, .. }) = CitadelStore::open(&path) else {
            panic!("a damaged file opened");
        };
        assert_eq!(failure, OpenFailure::Corrupt);

        let aside = CitadelStore::set_aside(&path).unwrap();
        assert!(std::fs::read(&aside).unwrap().starts_with(b"not sqlite"));
        let store = open(&path);
        assert!(store.users().unwrap().is_empty());
    }

    #[test]
    fn a_backup_replaces_the_database_and_the_old_one_is_kept() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("citadel.db");
        open(&path).create_user("first", "a long password").unwrap();
        let version = migrations::known_versions().unwrap().pop().unwrap();
        let backup = directory
            .path()
            .join(format!("citadel.db.{BACKUP_SUFFIX}{version}"));
        snapshot(&path, &backup);
        snapshot(
            &path,
            &directory
                .path()
                .join(format!("citadel.db.{BACKUP_SUFFIX}99990101000000")),
        );
        open(&path)
            .create_user("second", "a long password")
            .unwrap();

        let backups = CitadelStore::backups(&path).unwrap();
        assert_eq!(backups.len(), 1, "only backups this build can open");
        assert_eq!(backups[0].path, backup);

        let aside = CitadelStore::restore_backup(&path, &backups[0].path).unwrap();
        let names = |store: CitadelStore| -> Vec<String> {
            store
                .users()
                .unwrap()
                .into_iter()
                .map(|summary| summary.user.username)
                .collect()
        };
        assert_eq!(names(open(&path)), ["first"]);
        assert_eq!(names(open(&aside)), ["first", "second"]);
        assert!(backup.exists());
    }
}
