//! Who may do what: sign-in checks, browser sessions, OPDS app passwords and
//! library grants.
use std::sync::OnceLock;

use argon2::{password_hash::PasswordHash, Argon2, PasswordVerifier};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use diesel::prelude::*;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};

use super::{
    libraries::known_library,
    schema::{library_grants, sessions, users},
    unix_now,
    users::{hash_password, User},
    CitadelStore, Result, StoreError,
};

pub const SESSION_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
/// Sliding expiry is refreshed at most this often, so reads stay reads.
const SESSION_REFRESH_SECONDS: i64 = 60 * 60;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppCredential {
    pub username: String,
    pub password: String,
}

impl CitadelStore {
    /// Returns the user when the password matches. Unknown users still pay
    /// for one hash verification so timing does not reveal which names exist.
    pub fn verify_password(&self, username: &str, password: &str) -> Result<Option<User>> {
        let found = users::table
            .filter(users::username.eq(username.trim()))
            .select((users::id, users::username, users::password_hash))
            .first::<(String, String, Option<String>)>(&mut *self.connection())
            .optional()?;
        let (user, hash) = match found {
            Some((id, username, Some(hash))) => (Some(User { id, username }), hash),
            _ => (None, dummy_hash().to_string()),
        };
        let matches = PasswordHash::new(&hash)
            .map(|hash| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &hash)
                    .is_ok()
            })
            .unwrap_or(false);
        Ok(user.filter(|_| matches))
    }

    /// Returns the opaque cookie token; only its SHA-256 is stored.
    pub fn create_session(&self, user_id: &str) -> Result<String> {
        self.create_session_at(user_id, unix_now())
    }

    fn create_session_at(&self, user_id: &str, now: i64) -> Result<String> {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        let token = URL_SAFE_NO_PAD.encode(bytes);
        let mut connection = self.connection();
        connection.immediate_transaction(|connection| {
            diesel::delete(sessions::table.filter(sessions::expires_at.le(now)))
                .execute(connection)?;
            diesel::insert_into(sessions::table)
                .values((
                    sessions::token_hash.eq(token_hash(&token)),
                    sessions::user_id.eq(user_id),
                    sessions::created_at.eq(now),
                    sessions::expires_at.eq(now + SESSION_TTL_SECONDS),
                ))
                .execute(connection)?;
            Ok::<_, StoreError>(())
        })?;
        Ok(token)
    }

    pub fn session_user(&self, token: &str) -> Result<Option<User>> {
        self.session_user_at(token, unix_now())
    }

    fn session_user_at(&self, token: &str, now: i64) -> Result<Option<User>> {
        let hash = token_hash(token);
        let mut connection = self.connection();
        let found = sessions::table
            .inner_join(users::table)
            .filter(sessions::token_hash.eq(&hash))
            .filter(sessions::expires_at.gt(now))
            .select((users::id, users::username, sessions::expires_at))
            .first::<(String, String, i64)>(&mut *connection)
            .optional()?;
        let Some((id, username, expires_at)) = found else {
            return Ok(None);
        };
        if expires_at - now < SESSION_TTL_SECONDS - SESSION_REFRESH_SECONDS {
            diesel::update(sessions::table.filter(sessions::token_hash.eq(&hash)))
                .set(sessions::expires_at.eq(now + SESSION_TTL_SECONDS))
                .execute(&mut *connection)?;
        }
        Ok(Some(User { id, username }))
    }

    pub fn delete_session(&self, token: &str) -> Result<()> {
        diesel::delete(sessions::table.filter(sessions::token_hash.eq(token_hash(token))))
            .execute(&mut *self.connection())?;
        Ok(())
    }

    /// The user's OPDS app password, if they have one.
    pub fn app_password(&self, username: &str) -> Result<Option<AppCredential>> {
        let user = self.user(username)?;
        let password = users::table
            .filter(users::id.eq(&user.id))
            .select(users::app_password)
            .first::<Option<String>>(&mut *self.connection())?;
        Ok(password.map(|password| AppCredential {
            username: user.username,
            password,
        }))
    }

    pub fn rotate_app_password(&self, username: &str) -> Result<AppCredential> {
        let user = self.user(username)?;
        let password = crate::password::generate_app_password();
        diesel::update(users::table.filter(users::id.eq(&user.id)))
            .set(users::app_password.eq(&password))
            .execute(&mut *self.connection())?;
        Ok(AppCredential {
            username: user.username,
            password,
        })
    }

    pub fn grant(&self, username: &str, library_id: &str) -> Result<()> {
        let user = self.user(username)?;
        let mut connection = self.connection();
        known_library(&mut connection, library_id)?;
        diesel::insert_or_ignore_into(library_grants::table)
            .values((
                library_grants::user_id.eq(&user.id),
                library_grants::library_id.eq(library_id),
                library_grants::created_at.eq(unix_now()),
            ))
            .execute(&mut *connection)?;
        Ok(())
    }

    pub fn revoke(&self, username: &str, library_id: &str) -> Result<()> {
        let user = self.user(username)?;
        let mut connection = self.connection();
        known_library(&mut connection, library_id)?;
        diesel::delete(
            library_grants::table
                .filter(library_grants::user_id.eq(&user.id))
                .filter(library_grants::library_id.eq(library_id)),
        )
        .execute(&mut *connection)?;
        Ok(())
    }

    pub fn can_access(&self, user_id: &str, library_id: &str) -> Result<bool> {
        Ok(diesel::select(diesel::dsl::exists(
            library_grants::table
                .filter(library_grants::user_id.eq(user_id))
                .filter(library_grants::library_id.eq(library_id)),
        ))
        .get_result(&mut *self.connection())?)
    }

    /// OPDS app passwords for every user who can see `library_id`.
    pub fn app_credentials(&self, library_id: &str) -> Result<Vec<AppCredential>> {
        Ok(users::table
            .inner_join(library_grants::table)
            .filter(library_grants::library_id.eq(library_id))
            .order(users::username)
            .filter(users::app_password.is_not_null())
            .select((users::username, users::app_password.assume_not_null()))
            .load::<(String, String)>(&mut *self.connection())?
            .into_iter()
            .map(|(username, password)| AppCredential { username, password })
            .collect())
    }
}

fn dummy_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| hash_password("citadel-unknown-user").unwrap_or_default())
}

fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::test_support::store;
    use super::*;

    #[test]
    fn sessions_are_opaque_slide_and_are_revoked_by_password_changes() {
        let (_directory, store, _) = store();
        let alice = store.create_user("alice", "correct horse").unwrap();
        let token = store.create_session_at(&alice.id, 1_000).unwrap();
        let stored: String = sessions::table
            .select(sessions::token_hash)
            .first(&mut *store.connection())
            .unwrap();
        assert_ne!(stored, token);
        assert_eq!(
            store.session_user_at(&token, 1_001).unwrap(),
            Some(alice.clone())
        );
        let late = 1_000 + SESSION_TTL_SECONDS - 1;
        assert!(store.session_user_at(&token, late).unwrap().is_some());
        assert!(store
            .session_user_at(&token, late + SESSION_TTL_SECONDS - 1)
            .unwrap()
            .is_some());
        assert!(store
            .session_user_at(&token, late + 2 * SESSION_TTL_SECONDS)
            .unwrap()
            .is_none());
        assert!(store.session_user_at("forged", 1_001).unwrap().is_none());

        let token = store.create_session(&alice.id).unwrap();
        store.set_password("alice", "new password").unwrap();
        assert!(store.session_user(&token).unwrap().is_none());
        let token = store.create_session(&alice.id).unwrap();
        store.delete_session(&token).unwrap();
        assert!(store.session_user(&token).unwrap().is_none());
    }

    #[test]
    fn grants_scope_access_and_opds_app_passwords() {
        let (_directory, store, library) = store();
        let alice = store.create_user("alice", "correct horse").unwrap();
        store.create_user("kid", "another password").unwrap();
        assert!(!store.can_access(&alice.id, &library.id).unwrap());
        assert!(store.app_credentials(&library.id).unwrap().is_empty());
        store.grant("alice", &library.id).unwrap();
        store.grant("alice", &library.id).unwrap();
        assert!(store.can_access(&alice.id, &library.id).unwrap());
        let app = store.app_password("alice").unwrap().unwrap();
        assert_eq!(
            store.app_credentials(&library.id).unwrap(),
            vec![app.clone()]
        );
        let rotated = store.rotate_app_password("alice").unwrap();
        assert_ne!(rotated.password, app.password);
        assert_eq!(store.app_password("alice").unwrap(), Some(rotated));
        assert!(matches!(
            store.grant("alice", "missing"),
            Err(StoreError::NotFound(_))
        ));
        let summaries = store.users().unwrap();
        assert_eq!(summaries[0].library_ids, vec![library.id.clone()]);
        assert!(summaries[1].library_ids.is_empty());
        store.revoke("alice", &library.id).unwrap();
        assert!(!store.can_access(&alice.id, &library.id).unwrap());
        store.grant("alice", &library.id).unwrap();
        store.remove_user("alice").unwrap();
        assert!(store.app_credentials(&library.id).unwrap().is_empty());
        assert!(matches!(store.user("alice"), Err(StoreError::NotFound(_))));
    }
}
