//! Who may do what: sign-in checks, browser sessions and library grants.
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
    users::{hash_password, user_from_row, User, UserRow},
    CitadelStore, Result, StoreError,
};

pub const SESSION_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;
/// Sliding expiry is refreshed at most this often, so reads stay reads.
const SESSION_REFRESH_SECONDS: i64 = 60 * 60;

impl CitadelStore {
    /// Returns the user when the password matches. Unknown users still pay
    /// for one hash verification so timing does not reveal which names exist.
    pub fn verify_password(&self, username: &str, password: &str) -> Result<Option<User>> {
        let found = users::table
            .filter(users::username.eq(username.trim()))
            .select((
                users::id,
                users::username,
                users::role,
                users::password_hash,
            ))
            .first::<(String, String, String, Option<String>)>(&mut *self.connection())
            .optional()?;
        let (user, hash) = match found {
            Some((id, username, role, Some(hash))) => {
                (Some(user_from_row((id, username, role))?), hash)
            }
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
            .select((
                (users::id, users::username, users::role),
                sessions::expires_at,
            ))
            .first::<(UserRow, i64)>(&mut *connection)
            .optional()?;
        let Some((row, expires_at)) = found else {
            return Ok(None);
        };
        if expires_at - now < SESSION_TTL_SECONDS - SESSION_REFRESH_SECONDS {
            diesel::update(sessions::table.filter(sessions::token_hash.eq(&hash)))
                .set(sessions::expires_at.eq(now + SESSION_TTL_SECONDS))
                .execute(&mut *connection)?;
        }
        Ok(Some(user_from_row(row)?))
    }

    pub fn delete_session(&self, token: &str) -> Result<()> {
        diesel::delete(sessions::table.filter(sessions::token_hash.eq(token_hash(token))))
            .execute(&mut *self.connection())?;
        Ok(())
    }

    /// Gives the user access to the library, or changes the access they have.
    pub fn grant(
        &self,
        username: &str,
        library_id: &str,
        permission: LibraryPermission,
    ) -> Result<()> {
        let user = self.user(username)?;
        let mut connection = self.connection();
        known_library(&mut connection, library_id)?;
        let can_edit = permission == LibraryPermission::Edit;
        diesel::insert_into(library_grants::table)
            .values((
                library_grants::user_id.eq(&user.id),
                library_grants::library_id.eq(library_id),
                library_grants::created_at.eq(unix_now()),
                library_grants::can_edit.eq(can_edit),
            ))
            .on_conflict((library_grants::user_id, library_grants::library_id))
            .do_update()
            .set(library_grants::can_edit.eq(can_edit))
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

    /// What the user may do with the library, or `None` without a grant.
    pub fn library_permission(
        &self,
        user_id: &str,
        library_id: &str,
    ) -> Result<Option<LibraryPermission>> {
        Ok(library_grants::table
            .filter(library_grants::user_id.eq(user_id))
            .filter(library_grants::library_id.eq(library_id))
            .select(library_grants::can_edit)
            .first::<bool>(&mut *self.connection())
            .optional()?
            .map(LibraryPermission::from_can_edit))
    }

    pub fn can_access(&self, user_id: &str, library_id: &str) -> Result<bool> {
        Ok(self.library_permission(user_id, library_id)?.is_some())
    }
}

/// What a grant lets its user do with a library (ADR 0014).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LibraryPermission {
    /// Browse, read and download, but change nothing.
    View,
    Edit,
}

impl LibraryPermission {
    pub(super) fn from_can_edit(can_edit: bool) -> Self {
        if can_edit {
            Self::Edit
        } else {
            Self::View
        }
    }

    pub fn can_edit(self) -> bool {
        self == Self::Edit
    }
}

/// One library a user is granted, and what they may do with it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LibraryGrant {
    pub library_id: String,
    pub permission: LibraryPermission,
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
    use LibraryPermission::{Edit, View};

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
    fn grants_scope_access() {
        let (_directory, store, library) = store();
        let alice = store.create_user("alice", "correct horse").unwrap();
        store.create_user("kid", "another password").unwrap();
        assert!(!store.can_access(&alice.id, &library.id).unwrap());
        store.grant("alice", &library.id, Edit).unwrap();
        store.grant("alice", &library.id, Edit).unwrap();
        assert!(store.can_access(&alice.id, &library.id).unwrap());
        assert!(matches!(
            store.grant("alice", "missing", Edit),
            Err(StoreError::NotFound(_))
        ));
        let summaries = store.users().unwrap();
        assert_eq!(
            summaries[0].grants,
            vec![LibraryGrant {
                library_id: library.id.clone(),
                permission: Edit
            }]
        );
        assert!(summaries[1].grants.is_empty());
        store.revoke("alice", &library.id).unwrap();
        assert!(!store.can_access(&alice.id, &library.id).unwrap());
        store.grant("alice", &library.id, Edit).unwrap();
        store.remove_user("alice").unwrap();
        assert!(!store.can_access(&alice.id, &library.id).unwrap());
        assert!(matches!(store.user("alice"), Err(StoreError::NotFound(_))));
    }

    #[test]
    fn grants_can_be_view_only_and_changed_in_place() {
        let (_directory, store, library) = store();
        let kid = store.create_user("kid", "another password").unwrap();
        assert_eq!(
            store.library_permission(&kid.id, &library.id).unwrap(),
            None
        );
        store.grant("kid", &library.id, View).unwrap();
        assert_eq!(
            store.library_permission(&kid.id, &library.id).unwrap(),
            Some(View)
        );
        assert!(store.can_access(&kid.id, &library.id).unwrap());
        assert_eq!(store.users().unwrap()[0].grants[0].permission, View);
        store.grant("kid", &library.id, Edit).unwrap();
        assert_eq!(
            store.library_permission(&kid.id, &library.id).unwrap(),
            Some(Edit)
        );
        store.grant("kid", &library.id, View).unwrap();
        assert_eq!(
            store.library_permission(&kid.id, &library.id).unwrap(),
            Some(View)
        );
        let rows: i64 = library_grants::table
            .count()
            .get_result(&mut *store.connection())
            .unwrap();
        assert_eq!(rows, 1, "changing a grant keeps one row");
    }
}
