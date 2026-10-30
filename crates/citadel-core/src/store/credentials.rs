//! Users' own third-party API keys, sealed with the host's [`Vault`] (ADR
//! 0011). Secrets go in and come out only for the request that needs them;
//! listings show the provider account's label, never the secret.
use diesel::prelude::*;

use super::{schema::provider_credentials, unix_now, CitadelStore, Result, StoreError};
use crate::vault::Vault;

const PURPOSE: &[u8] = b"citadel/provider-credential/v1";
const MAX_SECRET_BYTES: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderCredential {
    pub provider: String,
    /// The provider account's name, when the provider reported one.
    pub label: Option<String>,
    pub created_at: i64,
    pub verified_at: Option<i64>,
    /// Sealed with a key this host no longer has; the user must enter it again.
    pub needs_reentry: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CredentialSecret {
    Available(String),
    NeedsReentry,
}

#[derive(Queryable)]
struct Row {
    provider: String,
    key_id: String,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    label: Option<String>,
    created_at: i64,
    verified_at: Option<i64>,
}

const COLUMNS: (
    provider_credentials::provider,
    provider_credentials::key_id,
    provider_credentials::nonce,
    provider_credentials::ciphertext,
    provider_credentials::label,
    provider_credentials::created_at,
    provider_credentials::verified_at,
) = (
    provider_credentials::provider,
    provider_credentials::key_id,
    provider_credentials::nonce,
    provider_credentials::ciphertext,
    provider_credentials::label,
    provider_credentials::created_at,
    provider_credentials::verified_at,
);

/// Binds a sealed value to its row, so it can't be moved to another user or
/// provider by editing the database.
fn aad(user_id: &str, provider: &str) -> Vec<u8> {
    [
        PURPOSE,
        b"\0",
        user_id.as_bytes(),
        b"\0",
        provider.as_bytes(),
    ]
    .concat()
}

impl Row {
    fn secret(&self, vault: &Vault, user_id: &str) -> CredentialSecret {
        if self.key_id != vault.key_id() {
            return CredentialSecret::NeedsReentry;
        }
        vault
            .open(&aad(user_id, &self.provider), &self.nonce, &self.ciphertext)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .map_or(CredentialSecret::NeedsReentry, CredentialSecret::Available)
    }

    fn summary(self, vault: &Vault, user_id: &str) -> ProviderCredential {
        let needs_reentry = self.secret(vault, user_id) == CredentialSecret::NeedsReentry;
        ProviderCredential {
            provider: self.provider,
            label: self.label,
            created_at: self.created_at,
            verified_at: self.verified_at,
            needs_reentry,
        }
    }
}

impl CitadelStore {
    /// Seals and stores (or replaces) a user's key for a provider. The caller
    /// verifies it with the provider first, so it is saved as verified now.
    pub fn save_provider_credential(
        &self,
        vault: &Vault,
        user_id: &str,
        provider: &str,
        secret: &str,
        label: Option<&str>,
    ) -> Result<ProviderCredential> {
        if secret.is_empty() || secret.len() > MAX_SECRET_BYTES {
            return Err(StoreError::Invalid(format!(
                "provider keys must be between 1 and {MAX_SECRET_BYTES} bytes"
            )));
        }
        let now = unix_now();
        let sealed = vault.seal(&aad(user_id, provider), secret.as_bytes());
        let values = (
            provider_credentials::user_id.eq(user_id),
            provider_credentials::provider.eq(provider),
            provider_credentials::key_id.eq(vault.key_id()),
            provider_credentials::nonce.eq(&sealed.nonce),
            provider_credentials::ciphertext.eq(&sealed.ciphertext),
            provider_credentials::label.eq(label),
            provider_credentials::created_at.eq(now),
            provider_credentials::verified_at.eq(Some(now)),
        );
        diesel::replace_into(provider_credentials::table)
            .values(values)
            .execute(&mut *self.connection())
            .map_err(|error| match error {
                diesel::result::Error::DatabaseError(
                    diesel::result::DatabaseErrorKind::ForeignKeyViolation,
                    _,
                ) => StoreError::NotFound(format!("no user {user_id}")),
                error => error.into(),
            })?;
        Ok(ProviderCredential {
            provider: provider.to_string(),
            label: label.map(String::from),
            created_at: now,
            verified_at: Some(now),
            needs_reentry: false,
        })
    }

    /// The user's key for a provider, for the request about to use it.
    pub fn provider_credential_secret(
        &self,
        vault: &Vault,
        user_id: &str,
        provider: &str,
    ) -> Result<Option<CredentialSecret>> {
        Ok(provider_credentials::table
            .filter(provider_credentials::user_id.eq(user_id))
            .filter(provider_credentials::provider.eq(provider))
            .select(COLUMNS)
            .first::<Row>(&mut *self.connection())
            .optional()?
            .map(|row| row.secret(vault, user_id)))
    }

    pub fn provider_credentials(
        &self,
        vault: &Vault,
        user_id: &str,
    ) -> Result<Vec<ProviderCredential>> {
        Ok(provider_credentials::table
            .filter(provider_credentials::user_id.eq(user_id))
            .order(provider_credentials::provider)
            .select(COLUMNS)
            .load::<Row>(&mut *self.connection())?
            .into_iter()
            .map(|row| row.summary(vault, user_id))
            .collect())
    }

    pub fn mark_provider_credential_verified(&self, user_id: &str, provider: &str) -> Result<()> {
        diesel::update(
            provider_credentials::table
                .filter(provider_credentials::user_id.eq(user_id))
                .filter(provider_credentials::provider.eq(provider)),
        )
        .set(provider_credentials::verified_at.eq(Some(unix_now())))
        .execute(&mut *self.connection())?;
        Ok(())
    }

    /// Returns whether there was a key to delete.
    pub fn delete_provider_credential(&self, user_id: &str, provider: &str) -> Result<bool> {
        Ok(diesel::delete(
            provider_credentials::table
                .filter(provider_credentials::user_id.eq(user_id))
                .filter(provider_credentials::provider.eq(provider)),
        )
        .execute(&mut *self.connection())?
            > 0)
    }

    /// How many stored keys this vault can't open, so a host can warn at
    /// startup after a key file was lost or replaced.
    pub fn unreadable_provider_credentials(&self, vault: &Vault) -> Result<usize> {
        let rows = provider_credentials::table
            .select((provider_credentials::user_id, COLUMNS))
            .load::<(String, Row)>(&mut *self.connection())?;
        Ok(rows
            .iter()
            .filter(|(user_id, row)| row.secret(vault, user_id) == CredentialSecret::NeedsReentry)
            .count())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::test_support::store;

    #[test]
    fn keys_round_trip_and_listings_never_include_them() {
        let (_directory, store, _) = store();
        let user = store.create_user("reader", "reader-password").unwrap();
        let vault = Vault::from_key([1; 32]);
        assert_eq!(
            store
                .provider_credential_secret(&vault, &user.id, "hardcover")
                .unwrap(),
            None
        );
        store
            .save_provider_credential(&vault, &user.id, "hardcover", "token-1", Some("reader"))
            .unwrap();
        assert_eq!(
            store
                .provider_credential_secret(&vault, &user.id, "hardcover")
                .unwrap(),
            Some(CredentialSecret::Available("token-1".into()))
        );
        let listed = store.provider_credentials(&vault, &user.id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label.as_deref(), Some("reader"));
        assert!(!listed[0].needs_reentry);
        assert!(!format!("{listed:?}").contains("token-1"));

        store
            .save_provider_credential(&vault, &user.id, "hardcover", "token-2", None)
            .unwrap();
        assert_eq!(
            store
                .provider_credential_secret(&vault, &user.id, "hardcover")
                .unwrap(),
            Some(CredentialSecret::Available("token-2".into()))
        );
        assert!(store
            .delete_provider_credential(&user.id, "hardcover")
            .unwrap());
        assert!(!store
            .delete_provider_credential(&user.id, "hardcover")
            .unwrap());
    }

    #[test]
    fn database_never_holds_the_plaintext() {
        let (directory, store, _) = store();
        let user = store.create_user("reader", "reader-password").unwrap();
        let vault = Vault::from_key([1; 32]);
        store
            .save_provider_credential(&vault, &user.id, "hardcover", "plain-token-xyz", None)
            .unwrap();
        drop(store);
        for name in ["citadel.db", "citadel.db-wal"] {
            if let Ok(bytes) = std::fs::read(directory.path().join(name)) {
                assert!(
                    !bytes.windows(15).any(|window| window == b"plain-token-xyz"),
                    "{name}"
                );
            }
        }
    }

    #[test]
    fn another_key_or_a_moved_row_needs_reentry() {
        let (_directory, store, _) = store();
        let reader = store.create_user("reader", "reader-password").unwrap();
        let other = store.create_user("other", "other-password").unwrap();
        let vault = Vault::from_key([1; 32]);
        store
            .save_provider_credential(&vault, &reader.id, "hardcover", "token", None)
            .unwrap();

        let replaced = Vault::from_key([2; 32]);
        assert_eq!(
            store
                .provider_credential_secret(&replaced, &reader.id, "hardcover")
                .unwrap(),
            Some(CredentialSecret::NeedsReentry)
        );
        assert!(store.provider_credentials(&replaced, &reader.id).unwrap()[0].needs_reentry);
        assert_eq!(store.unreadable_provider_credentials(&replaced).unwrap(), 1);
        assert_eq!(store.unreadable_provider_credentials(&vault).unwrap(), 0);

        diesel::sql_query(format!(
            "UPDATE provider_credentials SET user_id = '{}'",
            other.id
        ))
        .execute(&mut *store.connection())
        .unwrap();
        assert_eq!(
            store
                .provider_credential_secret(&vault, &other.id, "hardcover")
                .unwrap(),
            Some(CredentialSecret::NeedsReentry)
        );
    }

    #[test]
    fn deleting_a_user_deletes_their_keys() {
        let (_directory, store, _) = store();
        let user = store.create_user("reader", "reader-password").unwrap();
        let vault = Vault::from_key([1; 32]);
        store
            .save_provider_credential(&vault, &user.id, "hardcover", "token", None)
            .unwrap();
        store.remove_user("reader").unwrap();
        assert_eq!(store.unreadable_provider_credentials(&vault).unwrap(), 0);
        let count: i64 = provider_credentials::table
            .count()
            .get_result(&mut *store.connection())
            .unwrap();
        assert_eq!(count, 0);
    }
}
