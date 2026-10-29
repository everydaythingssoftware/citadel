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

/// What the app does once a step has run.
#[derive(Debug, Eq, PartialEq)]
enum After {
    Restart,
    Exit,
}

impl PendingRecovery {
    /// Runs a step on disk; the caller restarts or exits as it says.
    fn run(&self, step: RecoveryStep) -> Result<After, String> {
        if !self.problem.steps.contains(&step) {
            return Err(format!("{step:?} can't help with this database."));
        }
        let database = &self.database;
        let done = match step {
            RecoveryStep::Quit => return Ok(After::Exit),
            RecoveryStep::Update => return Err("Updates install through the updater.".into()),
            RecoveryStep::RestoreBackup => {
                let backup = self
                    .backup
                    .as_ref()
                    .ok_or("There's no backup to restore.")?;
                CitadelStore::restore_backup(database, backup).map(drop)
            }
            RecoveryStep::StartFresh => CitadelStore::set_aside(database).map(drop),
            RecoveryStep::TryAgain => CitadelStore::retry_migration(database),
        };
        done.map(|()| After::Restart)
            .map_err(|error| error.to_string())
    }
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
    match pending.run(step)? {
        After::Restart => handle.restart(),
        After::Exit => handle.exit(0),
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

    fn files(app_data_dir: &Path, prefix: &str) -> Vec<PathBuf> {
        std::fs::read_dir(app_data_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(prefix)
            })
            .collect()
    }

    fn opened(app_data_dir: &Path) -> (LocalAccount, Option<RestoredDatabase>) {
        match open(app_data_dir) {
            Startup::Opened { account, restored } => (account, restored),
            Startup::NeedsRecovery(pending) => panic!("needed recovery: {:?}", pending.problem),
        }
    }

    fn needs_recovery(app_data_dir: &Path) -> PendingRecovery {
        match open(app_data_dir) {
            Startup::Opened { .. } => panic!("opened"),
            Startup::NeedsRecovery(pending) => pending,
        }
    }

    /// A healthy database with one backup, named for the local user.
    fn with_backup(app_data_dir: &Path) -> String {
        let (account, restored) = opened(app_data_dir);
        assert!(restored.is_none());
        let user = account.user().unwrap().username;
        drop(account);
        assert_eq!(files(app_data_dir, "citadel.db.backup-").len(), 1);
        user
    }

    fn sql(path: &Path, statement: &str) {
        use diesel::{connection::SimpleConnection, Connection};
        diesel::SqliteConnection::establish(path.to_str().unwrap())
            .unwrap()
            .batch_execute(statement)
            .unwrap();
    }

    #[test]
    fn opening_takes_a_snapshot_at_most_once_a_day() {
        let directory = tempfile::tempdir().unwrap();
        with_backup(directory.path());
        // Backup names are dated to the second; a second snapshot would show.
        std::thread::sleep(Duration::from_millis(1100));
        drop(opened(directory.path()));
        assert_eq!(files(directory.path(), "citadel.db.backup-").len(), 1);
    }

    #[test]
    fn a_damaged_database_goes_back_to_its_newest_backup_and_is_kept() {
        let directory = tempfile::tempdir().unwrap();
        let user = with_backup(directory.path());
        damage(directory.path());

        let (account, restored) = opened(directory.path());
        assert!(restored.unwrap().0.created_at.is_some());
        assert_eq!(account.user().unwrap().username, user);
        assert_eq!(files(directory.path(), "citadel.db.unusable-").len(), 1);
    }

    #[test]
    fn a_damaged_backup_gives_way_to_an_older_one() {
        let directory = tempfile::tempdir().unwrap();
        let user = with_backup(directory.path());
        let good = files(directory.path(), "citadel.db.backup-").remove(0);
        let name = good.file_name().unwrap().to_string_lossy().into_owned();
        let (prefix, taken_at) = name.rsplit_once('-').unwrap();
        let newer = directory.path().join(format!(
            "{prefix}-{}",
            taken_at.parse::<i64>().unwrap() + 60
        ));
        std::fs::write(&newer, b"a damaged backup, long enough for a header").unwrap();
        damage(directory.path());

        let (account, restored) = opened(directory.path());
        assert_eq!(restored.unwrap().0.path, good.display().to_string());
        assert_eq!(account.user().unwrap().username, user);
    }

    #[test]
    fn a_restored_backup_that_cannot_migrate_reports_that_instead_of_damage() {
        let directory = tempfile::tempdir().unwrap();
        with_backup(directory.path());
        // The backup claims an older version, but already has the newer
        // migration's table, so migrating it fails.
        let backup = files(directory.path(), "citadel.db.backup-").remove(0);
        sql(
            &backup,
            "DELETE FROM __diesel_schema_migrations \
             WHERE version = (SELECT MAX(version) FROM __diesel_schema_migrations);",
        );
        damage(directory.path());

        let pending = needs_recovery(directory.path());
        assert_eq!(pending.problem.kind, DatabaseProblemKind::MigrationFailed);
        assert_eq!(pending.problem.steps, [Update, StartFresh, Quit]);
    }

    #[test]
    fn a_damaged_database_without_backups_needs_recovery() {
        let directory = tempfile::tempdir().unwrap();
        damage(directory.path());
        let pending = needs_recovery(directory.path());
        assert_eq!(pending.problem.kind, DatabaseProblemKind::Damaged);
        assert!(pending.problem.backup.is_none());
        assert_eq!(pending.problem.steps, [StartFresh, Quit]);
    }

    #[test]
    fn a_newer_database_can_go_back_to_a_backup_this_version_can_open() {
        let directory = tempfile::tempdir().unwrap();
        let user = with_backup(directory.path());
        sql(
            &directory.path().join(DATABASE),
            "INSERT INTO __diesel_schema_migrations (version) VALUES ('99991231000000');",
        );

        let pending = needs_recovery(directory.path());
        assert_eq!(pending.problem.kind, DatabaseProblemKind::NewerVersion);
        assert!(pending.problem.backup.is_some());
        assert_eq!(pending.problem.steps, [Update, RestoreBackup, Quit]);
        assert_eq!(pending.run(RestoreBackup), Ok(After::Restart));

        let (account, restored) = opened(directory.path());
        assert!(restored.is_none());
        assert_eq!(account.user().unwrap().username, user);
        assert_eq!(files(directory.path(), "citadel.db.unusable-").len(), 1);
    }

    #[test]
    fn starting_fresh_keeps_the_old_file_and_opens_an_empty_database() {
        let directory = tempfile::tempdir().unwrap();
        damage(directory.path());
        let pending = needs_recovery(directory.path());
        assert_eq!(pending.run(StartFresh), Ok(After::Restart));
        drop(opened(directory.path()));
        assert_eq!(files(directory.path(), "citadel.db.unusable-").len(), 1);
    }

    #[test]
    fn steps_that_were_not_offered_are_refused_and_quit_exits() {
        let directory = tempfile::tempdir().unwrap();
        damage(directory.path());
        let pending = needs_recovery(directory.path());
        for step in [RestoreBackup, TryAgain, Update] {
            assert!(pending.run(step).is_err(), "{step:?} ran");
        }
        assert_eq!(pending.run(Quit), Ok(After::Exit));
        // Nothing was touched.
        assert!(files(directory.path(), "citadel.db.unusable-").is_empty());
    }
}
