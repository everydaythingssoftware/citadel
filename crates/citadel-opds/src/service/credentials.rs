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
        let credentials = StoredOpdsCredentials {
            username: username.trim().to_string(),
            password,
        };
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
            .get()
            .map(|credentials| OpdsAuthCredentials {
                username: credentials.username,
                password: credentials.password,
            });
        self.inner.auth.swap_credentials(snapshot);
    }
}
