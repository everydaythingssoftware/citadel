//! The desktop's local user in `citadel.db` (ADR 0009). Desktop writes are
//! attributed to it, and its app password is the OPDS sharing password.
use std::path::Path;

use citadel_core::{
    store::{CitadelStore, StoreError, User},
    Actor,
};
use citadel_opds::credential_store::{OpdsCredentialSecret, OpdsCredentialStatus};
use serde::Deserialize;

pub const DATABASE: &str = "citadel.db";
/// Pre-CDL-45 desktop sharing credentials; migrated into `citadel.db` once.
const LEGACY_CREDENTIALS: &str = "opds-credentials.json";

pub struct LocalAccount {
    store: CitadelStore,
    user_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyCredentials {
    username: String,
    password: String,
}

impl LocalAccount {
    /// Errors keep the store's reason, so startup can offer recovery for an
    /// [`StoreError::Unusable`] database.
    pub fn open(app_data_dir: &Path) -> Result<Self, StoreError> {
        let io = |error: std::io::Error| StoreError::Storage(error.to_string());
        std::fs::create_dir_all(app_data_dir).map_err(io)?;
        let store = CitadelStore::open(&app_data_dir.join(DATABASE))?;
        let legacy_path = app_data_dir.join(LEGACY_CREDENTIALS);
        // Unreadable files (pre-reveal verifier formats) carry no usable
        // password; they are dropped like the old loader ignored them.
        let legacy = std::fs::read(&legacy_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<LegacyCredentials>(&bytes).ok());
        let default_name = legacy
            .as_ref()
            .map(|credentials| credentials.username.clone())
            .or_else(|| std::env::var("USER").ok())
            .or_else(|| std::env::var("USERNAME").ok())
            .unwrap_or_default();
        let user = store.local_user(&default_name)?;
        let account = Self {
            store,
            user_id: user.id.clone(),
        };
        if legacy_path.exists() {
            if let Some(legacy) = legacy {
                account
                    .configure(&legacy.username, &legacy.password)
                    .map_err(StoreError::Storage)?;
            }
            std::fs::remove_file(&legacy_path).map_err(io)?;
        }
        Ok(account)
    }

    pub fn store(&self) -> &CitadelStore {
        &self.store
    }

    pub fn actor(&self) -> Actor {
        Actor::User {
            id: self.user_id.clone(),
        }
    }

    pub fn user(&self) -> Result<User, String> {
        self.store.local_user("").map_err(message)
    }

    pub fn opds_credentials(&self) -> Result<Option<OpdsCredentialSecret>, String> {
        let user = self.user()?;
        Ok(self
            .store
            .app_password(&user.username)
            .map_err(message)?
            .map(|credential| OpdsCredentialSecret {
                username: credential.username,
                password: credential.password,
            }))
    }

    pub fn opds_status(&self) -> Result<OpdsCredentialStatus, String> {
        let credentials = self.opds_credentials()?;
        Ok(OpdsCredentialStatus {
            configured: credentials.is_some(),
            username: credentials.map(|credentials| credentials.username),
        })
    }

    /// The OPDS username is the local user's name, so choosing one renames them.
    pub fn configure(&self, username: &str, password: &str) -> Result<(), String> {
        if password.is_empty() {
            return Err("Reader sign-in needs a non-empty username and password.".into());
        }
        let user = self.user()?;
        let user = self
            .store
            .rename_user(&user.username, username)
            .map_err(message)?;
        self.store
            .set_app_password(&user.username, Some(password))
            .map_err(message)
    }

    pub fn clear(&self) -> Result<(), String> {
        let user = self.user()?;
        self.store
            .set_app_password(&user.username, None)
            .map_err(message)
    }
}

fn message(error: StoreError) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_sharing_credentials_become_the_local_users_app_password() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join(LEGACY_CREDENTIALS),
            r#"{"username":"reader","password":"wren724=wolf"}"#,
        )
        .unwrap();
        let account = LocalAccount::open(directory.path()).unwrap();
        assert!(!directory.path().join(LEGACY_CREDENTIALS).exists());
        assert_eq!(
            account.opds_credentials().unwrap(),
            Some(OpdsCredentialSecret {
                username: "reader".into(),
                password: "wren724=wolf".into(),
            })
        );
        let actor = account.actor();
        drop(account);
        let reopened = LocalAccount::open(directory.path()).unwrap();
        assert_eq!(reopened.actor(), actor);
        assert_eq!(reopened.user().unwrap().username, "reader");
    }

    #[test]
    fn unreadable_legacy_files_are_discarded_and_sharing_can_be_cleared() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join(LEGACY_CREDENTIALS),
            r#"{"username":"reader","passwordVerifier":"$argon2id$..."}"#,
        )
        .unwrap();
        let account = LocalAccount::open(directory.path()).unwrap();
        assert!(!directory.path().join(LEGACY_CREDENTIALS).exists());
        assert!(!account.opds_status().unwrap().configured);
        account.configure("kid", "secret").unwrap();
        assert_eq!(
            account.opds_status().unwrap().username.as_deref(),
            Some("kid")
        );
        account.clear().unwrap();
        assert_eq!(account.opds_credentials().unwrap(), None);
        assert!(account.configure("bad:name", "secret").is_err());
        assert!(account.configure("kid", "").is_err());
    }
}
