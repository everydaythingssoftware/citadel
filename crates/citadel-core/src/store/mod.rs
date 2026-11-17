//! Citadel's own database (`citadel.db`): users, sessions, external
//! identities, the library registry and library grants. Hosts keep it in their
//! state directory, never inside a library (ADR 0003, ADR 0009).
//!
//! [`users`] owns accounts, [`auth`] owns sign-in, sessions and grants,
//! [`device_keys`] owns OPDS device keys, [`libraries`] owns the registry, [`migrations`] brings the file
//! up to date when it is opened, and [`recovery`] gets a host past a file it
//! can't open.
use std::{
    fmt,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use diesel::{connection::SimpleConnection, prelude::*, sqlite::SqliteConnection};

mod auth;
mod credentials;
mod device_keys;
mod libraries;
mod migrations;
mod recovery;
mod schema;
mod users;

pub use auth::{LibraryGrant, LibraryPermission, SESSION_TTL_SECONDS};
pub use credentials::{CredentialSecret, ProviderCredential};
pub use device_keys::{DeviceKey, DeviceKeyVerifier, NewDeviceKey};
pub use libraries::{canonical_path, RegisteredLibrary};
pub use recovery::Backup;
pub use users::{Role, User, UserSummary};

#[derive(Debug, Eq, PartialEq)]
pub enum StoreError {
    Invalid(String),
    NotFound(String),
    Conflict(String),
    Storage(String),
    /// `citadel.db` exists but can't be used as it is; see [`recovery`].
    Unusable {
        failure: OpenFailure,
        message: String,
    },
}

/// Why [`CitadelStore::open`] refused an existing database.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenFailure {
    /// Not a SQLite database, or one SQLite reports as damaged.
    Corrupt,
    /// Migrated by a build this one can't follow, usually a newer Citadel.
    Incompatible,
    /// A migration failed and was rolled back; the database is unchanged.
    MigrationFailed,
    /// Migration runs kept stopping partway (the process died); the database
    /// is unchanged.
    MigrationInterrupted,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message)
            | Self::NotFound(message)
            | Self::Conflict(message)
            | Self::Storage(message)
            | Self::Unusable { message, .. } => f.write_str(message),
        }
    }
}
impl std::error::Error for StoreError {}

impl From<diesel::result::Error> for StoreError {
    fn from(error: diesel::result::Error) -> Self {
        Self::Storage(format!("citadel.db: {error}"))
    }
}

type Result<T> = std::result::Result<T, StoreError>;

pub struct CitadelStore {
    connection: Mutex<SqliteConnection>,
    path: std::path::PathBuf,
}

impl CitadelStore {
    /// Opens `citadel.db`, creating it if needed, and applies pending
    /// migrations (see [`migrations`]).
    pub fn open(path: &Path) -> Result<Self> {
        let url = path
            .to_str()
            .ok_or_else(|| StoreError::Invalid("citadel.db path must be valid UTF-8".into()))?;
        let mut connection = SqliteConnection::establish(url).map_err(|error| {
            StoreError::Storage(format!("could not open {}: {error}", path.display()))
        })?;
        // The server and the admin CLI share this file from separate processes.
        connection
            .batch_execute(
                "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;",
            )
            .map_err(|error| opening_error(path, error))?;
        check_integrity(&mut connection, path)?;
        migrations::migrate(&mut connection, path)?;
        restrict_permissions(path);
        Ok(Self {
            connection: Mutex::new(connection),
            path: path.to_path_buf(),
        })
    }

    fn connection(&self) -> std::sync::MutexGuard<'_, SqliteConnection> {
        self.connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Differs from an earlier value once anything has been written to
    /// `citadel.db` since, by this store or by another process such as the
    /// admin CLI. It can also move on a write that was rolled back, which
    /// only costs a needless reload. Cheap enough to ask before every request.
    pub fn version(&self) -> Result<StoreVersion> {
        #[derive(QueryableByName)]
        struct Version {
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            others: i64,
            #[diesel(sql_type = diesel::sql_types::BigInt)]
            own: i64,
        }
        // data_version moves when another connection commits; this
        // connection's own writes show only in total_changes.
        let version = diesel::sql_query(
            "SELECT (SELECT data_version FROM pragma_data_version()) AS others, \
             total_changes() AS own",
        )
        .get_result::<Version>(&mut *self.connection())?;
        Ok(StoreVersion {
            others: version.others,
            own: version.own,
        })
    }
}

/// See [`CitadelStore::version`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StoreVersion {
    others: i64,
    own: i64,
}

/// SQLite's own check, cheap at citadel.db's size; damage found at open is
/// easier to recover from than damage found halfway through a request.
fn check_integrity(connection: &mut SqliteConnection, path: &Path) -> Result<()> {
    #[derive(QueryableByName)]
    struct Check {
        #[diesel(sql_type = diesel::sql_types::Text)]
        quick_check: String,
    }
    let problems: Vec<String> = diesel::sql_query("PRAGMA quick_check")
        .load::<Check>(connection)
        .map_err(|error| opening_error(path, error))?
        .into_iter()
        .map(|row| row.quick_check)
        .filter(|row| row != "ok")
        .collect();
    if problems.is_empty() {
        return Ok(());
    }
    Err(StoreError::Unusable {
        failure: OpenFailure::Corrupt,
        message: format!("{} is damaged: {}", path.display(), problems.join("; ")),
    })
}

fn opening_error(path: &Path, error: diesel::result::Error) -> StoreError {
    let message = error.to_string();
    if message.contains("not a database") || message.contains("malformed") {
        StoreError::Unusable {
            failure: OpenFailure::Corrupt,
            message: format!(
                "{} is not a readable Citadel database: {message}",
                path.display()
            ),
        }
    } else {
        StoreError::Storage(format!("citadel.db: {message}"))
    }
}

/// `citadel.db.<suffix>`, next to the database.
fn sidecar(path: &Path, suffix: &str) -> std::path::PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("citadel.db");
    path.with_file_name(format!("{name}.{suffix}"))
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

#[cfg(test)]
mod test_support {
    use super::{CitadelStore, RegisteredLibrary};

    pub const LIBRARY_ID: &str = "3f2b7c1e-calibre-library";

    pub fn store() -> (tempfile::TempDir, CitadelStore, RegisteredLibrary) {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("library")).unwrap();
        let store = CitadelStore::open(&directory.path().join("citadel.db")).unwrap();
        let library = store
            .register_library(LIBRARY_ID, &directory.path().join("library"), None)
            .unwrap();
        (directory, store, library)
    }
}

#[cfg(test)]
mod version_tests {
    use super::test_support::store;
    use super::CitadelStore;

    #[test]
    fn the_version_moves_with_any_commit_and_only_then() {
        let (directory, store, _) = store();
        let before = store.version().unwrap();
        assert_eq!(store.version().unwrap(), before, "reading changes nothing");

        store.create_user("own", "password").unwrap();
        let after_own = store.version().unwrap();
        assert_ne!(after_own, before, "this store's own write");

        let other = CitadelStore::open(&directory.path().join("citadel.db")).unwrap();
        other.create_user("other", "password").unwrap();
        assert_ne!(
            store.version().unwrap(),
            after_own,
            "another process's write"
        );
    }
}
