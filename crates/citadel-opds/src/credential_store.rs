//! Persistence for OPDS sharing credentials.
//!
//! The secret is stored reversibly and that is deliberate — the reader UI
//! reveals it on demand, so rotation is never forced (ADR 0005). The file is
//! 0600; a same-user attacker who can read it can already read every book in
//! the library, so hashing buys nothing here.

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

#[derive(Clone)]
pub(crate) struct OpdsCredentialStore {
    inner: Arc<CredentialStoreInner>,
}

struct CredentialStoreInner {
    path: Option<PathBuf>,
    credentials: RwLock<Option<StoredOpdsCredentials>>,
}

impl OpdsCredentialStore {
    pub fn load(path: PathBuf) -> io::Result<Self> {
        let credentials = match fs::read(&path) {
            // Unparseable contents (e.g. pre-reveal verifier files from a
            // nightly) mean no usable credentials; regeneration is the path
            // forward, so treat them as absent — but log it, because genuine
            // corruption deserves to be visible too.
            Ok(contents) => match serde_json::from_slice(&contents) {
                Ok(credentials) => Some(credentials),
                Err(error) => {
                    log::warn!("Ignoring unreadable OPDS credential file ({error}); regenerate reader sign-in.");
                    None
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        Ok(Self {
            inner: Arc::new(CredentialStoreInner {
                path: Some(path),
                credentials: RwLock::new(credentials),
            }),
        })
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self {
            inner: Arc::new(CredentialStoreInner {
                path: None,
                credentials: RwLock::new(None),
            }),
        }
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Option<StoredOpdsCredentials>> {
        self.inner
            .credentials
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Option<StoredOpdsCredentials>> {
        self.inner
            .credentials
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Disk is the source of truth; memory mirrors the last successful disk
    /// operation.
    pub fn status(&self) -> OpdsCredentialStatus {
        let credentials = self.read();
        OpdsCredentialStatus {
            configured: credentials.is_some(),
            username: credentials
                .as_ref()
                .map(|credentials| credentials.username.clone()),
        }
    }

    pub fn get(&self) -> Option<StoredOpdsCredentials> {
        self.read().clone()
    }

    pub fn secret(&self) -> Option<OpdsCredentialSecret> {
        self.get().map(|credentials| OpdsCredentialSecret {
            username: credentials.username,
            password: credentials.password,
        })
    }

    pub fn set(&self, credentials: StoredOpdsCredentials) -> io::Result<()> {
        if let Some(path) = &self.inner.path {
            persist(path, &credentials)?;
        }
        *self.write() = Some(credentials);
        Ok(())
    }

    pub fn clear(&self) -> io::Result<()> {
        if let Some(path) = &self.inner.path {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        *self.write() = None;
        Ok(())
    }
}

fn persist(path: &Path, credentials: &StoredOpdsCredentials) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("credential path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".opds-credentials-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(credentials).map_err(io::Error::other)?;

    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    fs::rename(&temporary, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_username_and_password_with_private_permissions() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("opds-credentials.json");
        let store = OpdsCredentialStore::load(path.clone()).unwrap();
        store
            .set(StoredOpdsCredentials {
                username: "reader".to_string(),
                password: "wren724=wolf".to_string(),
            })
            .unwrap();

        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.contains("reader"));
        assert!(contents.contains("wren724=wolf"));
        assert_eq!(
            OpdsCredentialStore::load(path)
                .unwrap()
                .get()
                .unwrap()
                .password,
            "wren724=wolf"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory.path().join("opds-credentials.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn legacy_verifier_files_are_treated_as_unconfigured() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("opds-credentials.json");
        fs::write(
            &path,
            r#"{"username":"reader","passwordVerifier":"$argon2id$abc"}"#,
        )
        .unwrap();

        let store = OpdsCredentialStore::load(path).unwrap();
        assert_eq!(
            store.status(),
            OpdsCredentialStatus {
                configured: false,
                username: None
            }
        );
    }

    #[test]
    fn clear_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("opds-credentials.json");
        let store = OpdsCredentialStore::load(path.clone()).unwrap();
        store
            .set(StoredOpdsCredentials {
                username: "reader".to_string(),
                password: "wren724=wolf".to_string(),
            })
            .unwrap();

        store.clear().unwrap();
        store.clear().unwrap();
        assert!(!path.exists());
        assert_eq!(
            store.status(),
            OpdsCredentialStatus {
                configured: false,
                username: None
            }
        );
    }
}
