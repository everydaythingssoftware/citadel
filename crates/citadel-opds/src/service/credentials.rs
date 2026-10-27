//! The credential half of [`OpdsService`]: status, set, generate, clear.
//! A child of `service` so it can reach the service's private state without
//! visibility holes.

use super::super::auth::OpdsAuthCredentials;
use super::super::password::{generate_password, GeneratedOpdsCredentials};
use super::OpdsService;
use crate::credential_store::{OpdsCredentialSecret, OpdsCredentialStatus, StoredOpdsCredentials};
use crate::{OpdsErrorCode, OpdsStatusError};

const USERNAME_FORBIDDEN: char = ':';

fn store_error(error: std::io::Error) -> OpdsStatusError {
    OpdsStatusError {
        code: OpdsErrorCode::Unexpected,
        message: error.to_string(),
    }
}

impl OpdsService {
    pub fn credential_status(&self) -> OpdsCredentialStatus {
        self.inner.credentials.status()
    }

    pub fn credential_secret(&self) -> Option<OpdsCredentialSecret> {
        self.inner.credentials.secret()
    }

    /// Stores new credentials and swaps the live auth snapshot. A running
    /// share keeps running; the next request already checks against the new
    /// secret.
    pub fn configure_credentials(
        &self,
        username: String,
        password: String,
    ) -> Result<OpdsCredentialStatus, OpdsStatusError> {
        let credentials = validate_credentials(username, password)?;
        self.inner
            .credentials
            .set(credentials)
            .map_err(store_error)?;
        self.swap_auth_from_store();
        Ok(self.credential_status())
    }

    pub fn generate_credentials(
        &self,
        username: String,
    ) -> Result<GeneratedOpdsCredentials, OpdsStatusError> {
        let password = generate_password();
        self.configure_credentials(username.clone(), password.clone())?;
        Ok(GeneratedOpdsCredentials { username, password })
    }

    /// Replaces a host-supplied user list in place, e.g. after the host's user
    /// database changed. Running listeners check the next request against it.
    pub fn replace_ephemeral_credentials(
        &self,
        users: Vec<OpdsCredentialSecret>,
    ) -> Result<(), OpdsStatusError> {
        self.inner
            .credentials
            .replace_ephemeral(validate_user_list(users)?)
            .map_err(store_error)?;
        self.swap_auth_from_store();
        Ok(())
    }

    /// Clearing credentials while sharing is gated on them must stop sharing:
    /// the running server's bind policy advertises credential-gated reach,
    /// and a snapshot with no secret could only reject everyone.
    pub async fn clear_credentials(&self) -> Result<OpdsCredentialStatus, OpdsStatusError> {
        self.stop_if_active().await;
        self.inner.credentials.clear().map_err(store_error)?;
        self.swap_auth_from_store();
        Ok(self.credential_status())
    }
}

impl OpdsService {
    pub(super) fn swap_auth_from_store(&self) {
        let snapshot = self
            .inner
            .credentials
            .all()
            .into_iter()
            .map(|credentials| OpdsAuthCredentials {
                username: credentials.username,
                password: credentials.password,
            })
            .collect();
        self.inner.auth.swap_credential_list(snapshot);
    }
}

pub(super) fn validate_user_list(
    users: Vec<OpdsCredentialSecret>,
) -> Result<Vec<StoredOpdsCredentials>, OpdsStatusError> {
    let mut names = std::collections::BTreeSet::new();
    users
        .into_iter()
        .map(|user| {
            let user = validate_credentials(user.username, user.password)?;
            if !names.insert(user.username.clone()) {
                return Err(OpdsStatusError {
                    code: OpdsErrorCode::ConfigurationConflict,
                    message: "Duplicate reader username.".into(),
                });
            }
            Ok(user)
        })
        .collect()
}

pub(super) fn validate_credentials(
    username: String,
    password: String,
) -> Result<StoredOpdsCredentials, OpdsStatusError> {
    if username.trim().is_empty() || password.is_empty() {
        return Err(OpdsStatusError {
            code: OpdsErrorCode::Unexpected,
            message: "Reader sign-in needs a non-empty username and password.".to_string(),
        });
    }
    // HTTP Basic splits `user:pass` at the first colon, so a colon in the
    // username could never authenticate.
    if username.contains(USERNAME_FORBIDDEN) {
        return Err(OpdsStatusError {
            code: OpdsErrorCode::Unexpected,
            message: "Usernames can't contain a colon (:).".to_string(),
        });
    }
    Ok(StoredOpdsCredentials {
        username: username.trim().to_string(),
        password,
    })
}
