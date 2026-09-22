//! The credential half of [`OpdsService`]: status, set, generate, clear.
//! A child of `service` so it can reach the service's private state without
//! visibility holes.

use super::super::auth::create_credentials;
use super::super::password::{generate_password, GeneratedOpdsCredentials};
use super::OpdsService;
use crate::credential_store::{OpdsCredentialStatus, StoredOpdsCredentials};
use crate::{OpdsErrorCode, OpdsStatusError};

impl OpdsService {
    pub fn credential_status(&self) -> OpdsCredentialStatus {
        self.inner.credentials.status()
    }

    pub async fn configure_credentials(
        &self,
        username: String,
        password: String,
    ) -> Result<OpdsCredentialStatus, OpdsStatusError> {
        self.stop_if_active().await;
        let credentials =
            create_credentials(username, password.as_bytes()).map_err(|error| OpdsStatusError {
                code: OpdsErrorCode::Unexpected,
                message: error.to_string(),
            })?;
        let credentials = StoredOpdsCredentials {
            username: credentials.username,
            password_verifier: credentials.verifier,
        };
        self.inner
            .credentials
            .set(credentials)
            .map_err(|error| OpdsStatusError {
                code: OpdsErrorCode::Unexpected,
                message: error.to_string(),
            })?;
        Ok(self.credential_status())
    }

    pub async fn generate_credentials(
        &self,
        username: String,
    ) -> Result<GeneratedOpdsCredentials, OpdsStatusError> {
        self.stop_if_active().await;
        let password = generate_password();
        let credentials =
            create_credentials(username.clone(), password.as_bytes()).map_err(|error| {
                OpdsStatusError {
                    code: OpdsErrorCode::Unexpected,
                    message: error.to_string(),
                }
            })?;
        let credentials = StoredOpdsCredentials {
            username: credentials.username,
            password_verifier: credentials.verifier,
        };
        self.inner
            .credentials
            .set(credentials)
            .map_err(|error| OpdsStatusError {
                code: OpdsErrorCode::Unexpected,
                message: error.to_string(),
            })?;
        Ok(GeneratedOpdsCredentials { username, password })
    }

    /// Clearing credentials while sharing is gated on them must stop sharing:
    /// the running server would keep accepting the password that no longer
    /// exists, or worse, keep its auth layer pointed at stale material.
    pub async fn clear_credentials(&self) -> Result<OpdsCredentialStatus, OpdsStatusError> {
        self.stop_if_active().await;
        self.inner
            .credentials
            .clear()
            .map_err(|error| OpdsStatusError {
                code: OpdsErrorCode::Unexpected,
                message: error.to_string(),
            })?;
        Ok(self.credential_status())
    }
}
