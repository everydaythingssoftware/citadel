//! The desktop's local user in `citadel.db` (ADR 0009). Desktop writes are
//! attributed to it, and its device keys are what OPDS readers sign in with
//! (ADR 0013).
use std::{path::Path, sync::Arc};

use citadel_core::{
    store::{CitadelStore, DeviceKey, DeviceKeyVerifier, NewDeviceKey, StoreError, User},
    Actor,
};
use serde::{Deserialize, Serialize};

pub const DATABASE: &str = "citadel.db";
/// Pre-CDL-45 desktop sharing credentials; migrated into `citadel.db` once.
const LEGACY_CREDENTIALS: &str = "opds-credentials.json";
/// What a password carried over from before device keys is called.
pub const EXISTING_PASSWORD_KEY: &str = "Existing password";

pub struct LocalAccount {
    store: Arc<CitadelStore>,
    user_id: String,
}

/// The local user's OPDS username and device keys, never their secrets.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpdsDeviceKeys {
    pub username: String,
    pub keys: Vec<DeviceKey>,
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
            store: Arc::new(store),
            user_id: user.id.clone(),
        };
        if legacy_path.exists() {
            if let Some(legacy) = legacy.filter(|legacy| !legacy.password.is_empty()) {
                let user = account
                    .store
                    .rename_user(&user.username, &legacy.username)?;
                account.store.import_device_key(
                    &user.username,
                    EXISTING_PASSWORD_KEY,
                    &legacy.password,
                )?;
            }
            std::fs::remove_file(&legacy_path).map_err(io)?;
        }
        Ok(account)
    }

    pub fn store(&self) -> &CitadelStore {
        &self.store
    }

    pub fn shared_store(&self) -> Arc<CitadelStore> {
        self.store.clone()
    }

    pub fn actor(&self) -> Actor {
        Actor::User {
            id: self.user_id.clone(),
        }
    }

    pub fn user(&self) -> Result<User, String> {
        self.store.local_user("").map_err(message)
    }

    pub fn device_keys(&self) -> Result<OpdsDeviceKeys, String> {
        let user = self.user()?;
        Ok(OpdsDeviceKeys {
            keys: self.store.device_keys(&user.username).map_err(message)?,
            username: user.username,
        })
    }

    pub fn opds_verifiers(&self) -> Result<Vec<DeviceKeyVerifier>, String> {
        let user = self.user()?;
        self.store
            .user_device_key_verifiers(&user.username)
            .map_err(message)
    }

    pub fn create_device_key(&self, name: &str) -> Result<NewDeviceKey, String> {
        let user = self.user()?;
        self.store
            .create_device_key(&user.username, name)
            .map_err(message)
    }

    pub fn rotate_device_key(&self, key_id: &str) -> Result<NewDeviceKey, String> {
        let user = self.user()?;
        self.store
            .rotate_device_key(&user.username, key_id)
            .map_err(message)
    }

    pub fn revoke_device_key(&self, key_id: &str) -> Result<(), String> {
        let user = self.user()?;
        self.store
            .revoke_device_key(&user.username, key_id)
            .map_err(message)
    }

    /// The OPDS username is the local user's name, so every device signs in
    /// with the new name afterwards.
    pub fn rename(&self, username: &str) -> Result<(), String> {
        let user = self.user()?;
        self.store
            .rename_user(&user.username, username)
            .map(drop)
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
    fn legacy_sharing_credentials_become_an_existing_password_key() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join(LEGACY_CREDENTIALS),
            r#"{"username":"reader","password":"wren724=wolf"}"#,
        )
        .unwrap();
        let account = LocalAccount::open(directory.path()).unwrap();
        assert!(!directory.path().join(LEGACY_CREDENTIALS).exists());
        let keys = account.device_keys().unwrap();
        assert_eq!(keys.username, "reader");
        assert_eq!(keys.keys.len(), 1);
        assert_eq!(keys.keys[0].name, EXISTING_PASSWORD_KEY);
        assert!(account.opds_verifiers().unwrap()[0].matches("reader", b"wren724=wolf"));
        let actor = account.actor();
        drop(account);
        let reopened = LocalAccount::open(directory.path()).unwrap();
        assert_eq!(reopened.actor(), actor);
        assert_eq!(reopened.user().unwrap().username, "reader");
    }

    #[test]
    fn unreadable_legacy_files_are_discarded_and_keys_are_managed() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join(LEGACY_CREDENTIALS),
            r#"{"username":"reader","passwordVerifier":"$argon2id$..."}"#,
        )
        .unwrap();
        let account = LocalAccount::open(directory.path()).unwrap();
        assert!(!directory.path().join(LEGACY_CREDENTIALS).exists());
        assert!(account.device_keys().unwrap().keys.is_empty());
        let kobo = account.create_device_key("Kobo").unwrap();
        account.rename("kid").unwrap();
        assert!(account.opds_verifiers().unwrap()[0].matches("kid", kobo.secret.as_bytes()));
        let rotated = account.rotate_device_key(&kobo.key.id).unwrap();
        assert!(account.opds_verifiers().unwrap()[0].matches("kid", rotated.secret.as_bytes()));
        account.revoke_device_key(&rotated.key.id).unwrap();
        assert!(account.opds_verifiers().unwrap().is_empty());
        assert!(account.rename("bad:name").is_err());
        assert!(account.create_device_key(" ").is_err());
    }
}
