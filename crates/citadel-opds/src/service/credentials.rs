//! The credential half of [`OpdsService`]: status and replace.
//! A child of `service` so it can reach the service's private state without
//! visibility holes.

use std::sync::Arc;

use citadel_core::store::DeviceKeyVerifier;

use super::OpdsService;
use crate::{
    auth::OpdsBasicAuth,
    credential_store::{OpdsCredentialStatus, OpdsCredentialStore},
};

/// See [`OpdsService::refresh_credentials_with`].
pub struct CredentialUpdate<'a> {
    store: &'a OpdsCredentialStore,
    auth: &'a OpdsBasicAuth,
}

impl CredentialUpdate<'_> {
    pub fn replace(&self, verifiers: Vec<DeviceKeyVerifier>) {
        self.store.replace(verifiers);
        self.auth.swap_credential_list(self.store.all());
    }
}

impl OpdsService {
    pub fn credential_status(&self) -> OpdsCredentialStatus {
        self.inner.credentials.status()
    }

    /// Replaces the host-supplied device keys, e.g. after the host's user
    /// database changed. Running listeners check the next request against them.
    pub fn replace_credentials(&self, verifiers: Vec<DeviceKeyVerifier>) {
        self.inner.credentials.replace(verifiers);
        self.swap_auth_from_store();
    }

    /// Called with a key's id after it signs in, at most hourly per key, on a
    /// blocking thread, so the host can record when each device was last seen.
    /// The request is served once it returns.
    pub fn on_device_key_used(&self, hook: impl Fn(&str) + Send + Sync + 'static) {
        self.inner.auth.set_key_used_hook(Arc::new(hook));
    }

    /// Called on a blocking thread before each sign-in is checked, so a host
    /// whose keys change elsewhere (another process) can apply the change to
    /// the next request. Install new keys through the update, while holding
    /// whatever the host uses to tell which change it has seen: two requests
    /// can ask at once.
    pub fn refresh_credentials_with(
        &self,
        refresh: impl Fn(&CredentialUpdate<'_>) + Send + Sync + 'static,
    ) {
        let store = self.inner.credentials.clone();
        self.inner
            .auth
            .set_credentials_refresh(Arc::new(move |auth: &OpdsBasicAuth| {
                refresh(&CredentialUpdate {
                    store: &store,
                    auth,
                })
            }));
    }

    #[cfg(test)]
    pub(crate) fn configure_credentials(
        &self,
        username: String,
        password: String,
    ) -> OpdsCredentialStatus {
        self.replace_credentials(vec![DeviceKeyVerifier::new("key", &username, &password)]);
        self.credential_status()
    }

    pub(super) fn swap_auth_from_store(&self) {
        self.inner
            .auth
            .swap_credential_list(self.inner.credentials.all());
    }
}
