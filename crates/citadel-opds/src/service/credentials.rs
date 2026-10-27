//! The credential half of [`OpdsService`]: status, replace, clear.
//! A child of `service` so it can reach the service's private state without
//! visibility holes.

use super::super::auth::OpdsAuthCredentials;
use super::OpdsService;
use crate::credential_store::{OpdsCredentialSecret, OpdsCredentialStatus, StoredOpdsCredentials};
use crate::{OpdsErrorCode, OpdsStatusError};

const USERNAME_FORBIDDEN: char = ':';

impl OpdsService {
    pub fn credential_status(&self) -> OpdsCredentialStatus {
        self.inner.credentials.status()
    }

    /// Replaces the host-supplied user list, e.g. after the host's user
    /// database changed. Running listeners check the next request against it.
    pub fn replace_credentials(
        &self,
        users: Vec<OpdsCredentialSecret>,
    ) -> Result<(), OpdsStatusError> {
        self.inner.credentials.replace(validate_user_list(users)?);
        self.swap_auth_from_store();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn configure_credentials(
        &self,
        username: String,
        password: String,
    ) -> Result<OpdsCredentialStatus, OpdsStatusError> {
        self.replace_credentials(vec![OpdsCredentialSecret { username, password }])?;
        Ok(self.credential_status())
    }

    #[cfg(test)]
    pub(crate) fn generate_credentials(
        &self,
        username: String,
    ) -> Result<crate::password::GeneratedOpdsCredentials, OpdsStatusError> {
        let password = crate::password::generate_password();
        self.configure_credentials(username.clone(), password.clone())?;
        Ok(crate::password::GeneratedOpdsCredentials { username, password })
    }

    /// Clearing credentials while sharing is gated on them must stop sharing:
    /// the running server's bind policy advertises credential-gated reach,
    /// and a snapshot with no secret could only reject everyone.
    pub async fn clear_credentials(&self) -> Result<OpdsCredentialStatus, OpdsStatusError> {
        self.stop_if_active().await;
        self.inner.credentials.replace(Vec::new());
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
