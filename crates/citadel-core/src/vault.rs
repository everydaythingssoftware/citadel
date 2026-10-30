//! The key that seals third-party secrets in `citadel.db` (ADR 0011). It
//! lives in its own file in the host's state directory, so a copy of the
//! database alone doesn't reveal users' provider keys.
use std::{
    fmt,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};

pub const KEY_FILE: &str = "credentials.key";
const KEY_BYTES: usize = 32;
pub(crate) const NONCE_BYTES: usize = 24;

pub struct Vault {
    cipher: XChaCha20Poly1305,
    key_id: String,
}

impl fmt::Debug for Vault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Vault")
            .field("key_id", &self.key_id)
            .finish_non_exhaustive()
    }
}

pub(crate) struct Sealed {
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

impl Vault {
    /// Reads `<directory>/credentials.key`, creating the directory (`0700`)
    /// and a new random key (`0600`) when there is none. A missing key file
    /// makes earlier sealed secrets unreadable; they are reported as needing
    /// re-entry rather than stopping the host.
    pub fn open_or_create(directory: &Path) -> Result<Self, String> {
        create_private_directory(directory)?;
        let path = directory.join(KEY_FILE);
        match std::fs::read(&path) {
            Ok(bytes) => Self::from_file_bytes(&path, &bytes),
            Err(error) if error.kind() == ErrorKind::NotFound => Self::create(&path),
            Err(error) => Err(format!("could not read {}: {error}", path.display())),
        }
    }

    fn create(path: &Path) -> Result<Self, String> {
        let mut key = [0u8; KEY_BYTES];
        OsRng.fill_bytes(&mut key);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        match options.open(path) {
            Ok(mut file) => {
                file.write_all(&key)
                    .and_then(|()| file.sync_all())
                    .map_err(|error| format!("could not write {}: {error}", path.display()))?;
                Ok(Self::from_key(key))
            }
            // Another process created it first; use theirs.
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let bytes = std::fs::read(path)
                    .map_err(|error| format!("could not read {}: {error}", path.display()))?;
                Self::from_file_bytes(path, &bytes)
            }
            Err(error) => Err(format!("could not create {}: {error}", path.display())),
        }
    }

    fn from_file_bytes(path: &Path, bytes: &[u8]) -> Result<Self, String> {
        let key: [u8; KEY_BYTES] = bytes.try_into().map_err(|_| {
            format!(
                "{} is damaged (expected {KEY_BYTES} bytes, found {}). Move it aside to start \
                 with a new key; users will need to re-enter their provider keys.",
                path.display(),
                bytes.len()
            )
        })?;
        Ok(Self::from_key(key))
    }

    pub fn from_key(key: [u8; KEY_BYTES]) -> Self {
        let digest = Sha256::new()
            .chain_update(b"citadel/vault-key-id/v1")
            .chain_update(key)
            .finalize();
        Self {
            cipher: XChaCha20Poly1305::new(&key.into()),
            key_id: digest[..8]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        }
    }

    /// Names the key without revealing it; stored beside each sealed value.
    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    pub(crate) fn seal(&self, aad: &[u8], plaintext: &[u8]) -> Sealed {
        let mut nonce = [0u8; NONCE_BYTES];
        OsRng.fill_bytes(&mut nonce);
        let ciphertext = self
            .cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .expect("XChaCha20-Poly1305 seals any in-memory value");
        Sealed {
            nonce: nonce.to_vec(),
            ciphertext,
        }
    }

    /// `None` when the value was sealed with another key, for another
    /// purpose or row, or has been altered.
    pub(crate) fn open(&self, aad: &[u8], nonce: &[u8], ciphertext: &[u8]) -> Option<Vec<u8>> {
        if nonce.len() != NONCE_BYTES {
            return None;
        }
        self.cipher
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad,
                },
            )
            .ok()
    }
}

fn create_private_directory(directory: &Path) -> Result<(), String> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(directory)
        .map_err(|error| format!("could not create {}: {error}", directory.display()))
}

/// Where hosts keep the vault: `<stateDirectory>/secrets`.
pub fn directory(state_directory: &Path) -> PathBuf {
    state_directory.join("secrets")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_values_open_only_with_the_same_key_and_aad() {
        let vault = Vault::from_key([7; KEY_BYTES]);
        let sealed = vault.seal(b"row-a", b"secret");
        assert_ne!(sealed.ciphertext, b"secret");
        assert_eq!(
            vault.open(b"row-a", &sealed.nonce, &sealed.ciphertext),
            Some(b"secret".to_vec())
        );
        assert_eq!(
            vault.open(b"row-b", &sealed.nonce, &sealed.ciphertext),
            None
        );
        let other = Vault::from_key([8; KEY_BYTES]);
        assert_ne!(other.key_id(), vault.key_id());
        assert_eq!(
            other.open(b"row-a", &sealed.nonce, &sealed.ciphertext),
            None
        );
        let mut altered = sealed.ciphertext.clone();
        altered[0] ^= 1;
        assert_eq!(vault.open(b"row-a", &sealed.nonce, &altered), None);
        assert_ne!(vault.seal(b"row-a", b"secret").nonce, sealed.nonce);
    }

    #[test]
    fn key_file_is_created_once_privately_and_reused() {
        let directory = tempfile::tempdir().unwrap();
        let secrets = directory.path().join("secrets");
        let first = Vault::open_or_create(&secrets).unwrap();
        let again = Vault::open_or_create(&secrets).unwrap();
        assert_eq!(first.key_id(), again.key_id());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&secrets), 0o700);
            assert_eq!(mode(&secrets.join(KEY_FILE)), 0o600);
        }
        std::fs::remove_file(secrets.join(KEY_FILE)).unwrap();
        assert_ne!(
            Vault::open_or_create(&secrets).unwrap().key_id(),
            first.key_id()
        );
    }

    #[test]
    fn damaged_key_file_is_refused_rather_than_replaced() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join(KEY_FILE), b"short").unwrap();
        let error = Vault::open_or_create(directory.path()).unwrap_err();
        assert!(error.contains("damaged"), "{error}");
        assert_eq!(
            std::fs::read(directory.path().join(KEY_FILE)).unwrap(),
            b"short"
        );
    }
}
