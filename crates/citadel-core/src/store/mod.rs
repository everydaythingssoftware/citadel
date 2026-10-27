//! Citadel's own database (`citadel.db`): users, sessions, external
//! identities, the library registry and library grants. Hosts keep it in their
//! state directory, never inside a library (ADR 0003, ADR 0009).
//!
//! [`users`] owns accounts, [`auth`] owns sign-in, sessions, app passwords and
//! grants, [`libraries`] owns the registry, and [`migrations`] brings the file
//! up to date when it is opened.
use std::{
    fmt,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use diesel::{connection::SimpleConnection, prelude::*, sqlite::SqliteConnection};

mod auth;
mod libraries;
mod migrations;
mod schema;
mod users;

pub use auth::{AppCredential, SESSION_TTL_SECONDS};
pub use libraries::RegisteredLibrary;
pub use users::{User, UserSummary};

#[derive(Debug, Eq, PartialEq)]
pub enum StoreError {
    Invalid(String),
    NotFound(String),
    Conflict(String),
    Storage(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message)
            | Self::NotFound(message)
            | Self::Conflict(message)
            | Self::Storage(message) => f.write_str(message),
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
            .map_err(|error| StoreError::Storage(format!("citadel.db: {error}")))?;
        migrations::migrate(&mut connection, path)?;
        restrict_permissions(path);
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn connection(&self) -> std::sync::MutexGuard<'_, SqliteConnection> {
        self.connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
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
