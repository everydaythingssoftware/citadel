//! The credential half of [`OpdsService`]: status and replace.
//! A child of `service` so it can reach the service's private state without
//! visibility holes.

use std::sync::Arc;

use citadel_core::store::DeviceKeyVerifier;

use super::OpdsService;
use crate::credential_store::OpdsCredentialStatus;

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
    pub fn on_device_key_used(&self, hook: impl Fn(&str) + Send + Sync + 'static) {
        self.inner.auth.set_key_used_hook(Arc::new(hook));
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
