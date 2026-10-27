//! In-memory OPDS sharing credentials, supplied by the host. Hosts own
//! persistence: both keep them in `citadel.db` as their users' app passwords,
//! stored reversibly so they can be revealed again (ADR 0005, ADR 0009).

use std::sync::{Arc, RwLock};

use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StoredOpdsCredentials {
    pub username: String,
    pub password: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpdsCredentialStatus {
    pub configured: bool,
    pub username: Option<String>,
}

/// The stored secret, for the reader UI's reveal flow. The password is kept
/// reversibly on purpose (ADR 0005); the app process may show it to its user.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpdsCredentialSecret {
    pub username: String,
    pub password: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedOpdsCredentials {
    pub username: String,
    pub password: String,
}

#[derive(Clone, Default)]
pub(crate) struct OpdsCredentialStore {
    credentials: Arc<RwLock<Vec<StoredOpdsCredentials>>>,
}

impl OpdsCredentialStore {
    pub fn new(credentials: Vec<StoredOpdsCredentials>) -> Self {
        Self {
            credentials: Arc::new(RwLock::new(credentials)),
        }
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Vec<StoredOpdsCredentials>> {
        self.credentials
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Vec<StoredOpdsCredentials>> {
        self.credentials
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn status(&self) -> OpdsCredentialStatus {
        let credentials = self.read();
        OpdsCredentialStatus {
            configured: !credentials.is_empty(),
            username: credentials
                .first()
                .map(|credentials| credentials.username.clone()),
        }
    }

    pub fn all(&self) -> Vec<StoredOpdsCredentials> {
        self.read().clone()
    }

    pub fn get(&self) -> Option<StoredOpdsCredentials> {
        self.read().first().cloned()
    }

    pub fn replace(&self, credentials: Vec<StoredOpdsCredentials>) {
        *self.write() = credentials;
    }
}
