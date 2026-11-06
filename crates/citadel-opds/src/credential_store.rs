//! In-memory OPDS sign-in verifiers, supplied by the host. Hosts own
//! persistence: both keep their users' device keys in `citadel.db`, hashed and
//! never shown again (ADR 0013).

use std::sync::{Arc, RwLock};

use citadel_core::store::DeviceKeyVerifier;
use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpdsCredentialStatus {
    pub configured: bool,
    pub username: Option<String>,
}

#[derive(Clone, Default)]
pub(crate) struct OpdsCredentialStore {
    verifiers: Arc<RwLock<Vec<DeviceKeyVerifier>>>,
}

impl OpdsCredentialStore {
    pub fn new(verifiers: Vec<DeviceKeyVerifier>) -> Self {
        Self {
            verifiers: Arc::new(RwLock::new(verifiers)),
        }
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Vec<DeviceKeyVerifier>> {
        self.verifiers
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn status(&self) -> OpdsCredentialStatus {
        let verifiers = self.read();
        OpdsCredentialStatus {
            configured: !verifiers.is_empty(),
            username: verifiers.first().map(|verifier| verifier.username.clone()),
        }
    }

    pub fn all(&self) -> Vec<DeviceKeyVerifier> {
        self.read().clone()
    }

    pub fn is_empty(&self) -> bool {
        self.read().is_empty()
    }

    pub fn replace(&self, verifiers: Vec<DeviceKeyVerifier>) {
        *self
            .verifiers
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = verifiers;
    }
}
