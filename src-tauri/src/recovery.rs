//! Opening `citadel.db` at startup, and what happens when it can't be opened
//! (ADR 0009). A damaged database goes back to its newest backup on its own,
//! and the app says so once it's open. Anything else comes up without a local
//! account and the window shows a recovery screen. The backend decides which
//! steps can help; the frontend owns the words.
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use citadel_core::store::{CitadelStore, OpenFailure, StoreError};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::account::{LocalAccount, DATABASE};

const SNAPSHOT_AGE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseProblemKind {
    Damaged,
    NewerVersion,
    MigrationFailed,
    MigrationInterrupted,
    Unreadable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryStep {
    /// Installs a newer Citadel; the frontend runs it through the updater.
    Update,
    RestoreBackup,
    StartFresh,
    TryAgain,
    Quit,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackup {
    pub path: String,
    /// RFC 3339, when it's known.
    pub created_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseProblem {
    pub kind: DatabaseProblemKind,
    pub database_path: String,
    pub details: String,
    pub backup: Option<DatabaseBackup>,
    /// The steps that can help, best first; `quit` is always last.
    pub steps: Vec<RecoveryStep>,
}

/// Managed in place of the local account when startup couldn't open it.
pub struct PendingRecovery {
    database: PathBuf,
    backup: Option<PathBuf>,
    problem: DatabaseProblem,
}

/// Managed when startup replaced a damaged database with a backup.
pub struct RestoredDatabase(pub DatabaseBackup);

pub enum Startup {
    Opened {
        account: LocalAccount,
        restored: Option<RestoredDatabase>,
    },
    NeedsRecovery(PendingRecovery),
}

/// Opens the local account. A damaged database is replaced by the newest
/// backup that opens (the damaged file is kept); after any successful open,
/// a backup is taken if the newest is a day old.
pub fn open(app_data_dir: &Path) -> Startup {
    let database = app_data_dir.join(DATABASE);
    let opened = match LocalAccount::open(app_data_dir) {
        Ok(account) => Ok((account, None)),
        Err(error) if kind(&error) == DatabaseProblemKind::Damaged => {
            restore_newest(app_data_dir, &database, error)
        }
        Err(error) => Err(error),
    };
    match opened {
        Ok((account, restored)) => {
            if let Err(error) = account.store().snapshot_if_older_than(SNAPSHOT_AGE) {
                eprintln!("citadel.db snapshot skipped: {error}");
            }
            Startup::Opened { account, restored }
        }
        Err(error) => Startup::NeedsRecovery(PendingRecovery::new(database, &error)),
    }
}

/// Tries backups newest first. A backup that is damaged too gives way to the
/// next; one that fails for another reason (say, a migration) is reported.
fn restore_newest(
    app_data_dir: &Path,
    database: &Path,
    damaged: StoreError,
) -> Result<(LocalAccount, Option<RestoredDatabase>), StoreError> {
    for backup in CitadelStore::backups(database).unwrap_or_default() {
        if CitadelStore::restore_backup(database, &backup.path).is_err() {
            continue;
        }
        match LocalAccount::open(app_data_dir) {
            Ok(account) => {
                let restored = RestoredDatabase(DatabaseBackup {
                    path: backup.path.display().to_string(),
                    created_at: backup.modified.map(rfc3339),
                });
                return Ok((account, Some(restored)));
            }
            Err(error) if kind(&error) == DatabaseProblemKind::Damaged => continue,
            Err(error) => return Err(error),
        }
    }
    Err(damaged)
}

fn rfc3339(time: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339()
}

impl PendingRecovery {
    fn new(database: PathBuf, error: &StoreError) -> Self {
        let kind = kind(error);
        // A damaged database already went through every backup.
        let newest = (kind != DatabaseProblemKind::Damaged)
            .then(|| CitadelStore::backups(&database).ok())
            .flatten()
            .and_then(|backups| backups.into_iter().next());
        let problem = DatabaseProblem {
            kind,
            database_path: database.display().to_string(),
            details: error.to_string(),
            backup: newest.as_ref().map(|backup| DatabaseBackup {
                path: backup.path.display().to_string(),
                created_at: backup.modified.map(rfc3339),
            }),
            steps: steps(kind, newest.is_some()),
        };
        Self {
            database,
            backup: newest.map(|backup| backup.path),
            problem,
        }
    }
}

fn kind(error: &StoreError) -> DatabaseProblemKind {
    match error {
        StoreError::Unusable { failure, .. } => match failure {
            OpenFailure::Corrupt => DatabaseProblemKind::Damaged,
            OpenFailure::Incompatible => DatabaseProblemKind::NewerVersion,
            OpenFailure::MigrationFailed => DatabaseProblemKind::MigrationFailed,
            OpenFailure::MigrationInterrupted => DatabaseProblemKind::MigrationInterrupted,
        },
        _ => DatabaseProblemKind::Unreadable,
    }
}

fn steps(kind: DatabaseProblemKind, has_backup: bool) -> Vec<RecoveryStep> {
    use RecoveryStep::*;
    let mut steps: Vec<RecoveryStep> = match kind {
        DatabaseProblemKind::Damaged => vec![StartFresh],
        DatabaseProblemKind::NewerVersion => [Update]
            .into_iter()
            .chain(has_backup.then_some(RestoreBackup))
            .collect(),
        // The database is unchanged, so a fixed release can still open it.
        DatabaseProblemKind::MigrationFailed => vec![Update, StartFresh],
        DatabaseProblemKind::MigrationInterrupted => vec![TryAgain, StartFresh],
        DatabaseProblemKind::Unreadable => Vec::new(),
    };
    steps.push(Quit);
    steps
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_database_problem(handle: tauri::AppHandle) -> Option<DatabaseProblem> {
    handle
        .try_state::<PendingRecovery>()
        .map(|pending| pending.problem.clone())
}

/// The backup a damaged database was replaced with at startup, if any.
#[tauri::command]
#[specta::specta]
pub fn clb_query_database_restored(handle: tauri::AppHandle) -> Option<DatabaseBackup> {
    handle
        .try_state::<RestoredDatabase>()
        .map(|restored| restored.0.clone())
}

/// Runs a recovery step, then restarts so startup opens the result.
#[tauri::command]
#[specta::specta]
pub fn clb_cmd_recover_database(
    handle: tauri::AppHandle,
    step: RecoveryStep,
) -> Result<(), String> {
    let pending = handle
        .try_state::<PendingRecovery>()
        .ok_or("Citadel's database doesn't need recovering.")?;
    if !pending.problem.steps.contains(&step) {
        return Err(format!("{step:?} can't help with this database."));
    }
    let database = &pending.database;
    match step {
        RecoveryStep::Quit => handle.exit(0),
        RecoveryStep::Update => return Err("Updates install through the updater.".into()),
        RecoveryStep::RestoreBackup => {
            let backup = pending
                .backup
                .as_ref()
                .ok_or("There's no backup to restore.")?;
            CitadelStore::restore_backup(database, backup).map_err(|error| error.to_string())?;
            handle.restart();
        }
        RecoveryStep::StartFresh => {
            CitadelStore::set_aside(database).map_err(|error| error.to_string())?;
            handle.restart();
        }
        RecoveryStep::TryAgain => {
            CitadelStore::retry_migration(database).map_err(|error| error.to_string())?;
            handle.restart();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use RecoveryStep::*;

    fn unusable(failure: OpenFailure) -> StoreError {
        StoreError::Unusable {
            failure,
            message: "details".into(),
        }
    }

    fn offered(error: StoreError, has_backup: bool) -> Vec<RecoveryStep> {
        steps(kind(&error), has_backup)
    }

    #[test]
    fn each_problem_offers_only_the_steps_that_can_help() {
        assert_eq!(
            offered(unusable(OpenFailure::Corrupt), true),
            [StartFresh, Quit]
        );
        assert_eq!(
            offered(unusable(OpenFailure::Incompatible), true),
            [Update, RestoreBackup, Quit]
        );
        assert_eq!(
            offered(unusable(OpenFailure::Incompatible), false),
            [Update, Quit]
        );
        assert_eq!(
            offered(unusable(OpenFailure::MigrationFailed), true),
            [Update, StartFresh, Quit]
        );
        assert_eq!(
            offered(unusable(OpenFailure::MigrationInterrupted), true),
            [TryAgain, StartFresh, Quit]
        );
        assert_eq!(offered(StoreError::Storage("disk".into()), true), [Quit]);
    }

    fn damage(app_data_dir: &Path) {
        let database = app_data_dir.join(DATABASE);
        for sidecar in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{sidecar}", database.display()));
        }
        std::fs::write(
            &database,
            b"not sqlite, just bytes long enough for a header",
        )
        .unwrap();
    }

    #[test]
    fn a_damaged_database_goes_back_to_its_newest_backup_and_is_kept() {
        let directory = tempfile::tempdir().unwrap();
        let app_data_dir = directory.path();
        let Startup::Opened { account, restored } = open(app_data_dir) else {
            panic!("a new database needed recovery");
        };
        assert!(restored.is_none());
        let user = account.user().unwrap().username;
        drop(account);
        damage(app_data_dir);

        let Startup::Opened { account, restored } = open(app_data_dir) else {
            panic!("the backup wasn't restored");
        };
        assert!(restored.is_some());
        assert_eq!(account.user().unwrap().username, user);
        assert!(std::fs::read_dir(app_data_dir).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("citadel.db.unusable-")));
    }

    #[test]
    fn a_damaged_database_without_backups_needs_recovery() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path()).unwrap();
        damage(directory.path());
        let Startup::NeedsRecovery(pending) = open(directory.path()) else {
            panic!("a damaged database opened");
        };
        assert_eq!(pending.problem.kind, DatabaseProblemKind::Damaged);
        assert!(pending.problem.backup.is_none());
        assert_eq!(pending.problem.steps, [StartFresh, Quit]);
    }
}
