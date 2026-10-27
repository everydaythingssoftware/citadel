//! Accounts: who exists, their names and their sign-in passwords.
use argon2::{
    password_hash::{rand_core::OsRng as HashRng, SaltString},
    Argon2, PasswordHasher,
};
use diesel::{prelude::*, sqlite::SqliteConnection};

use super::{
    schema::{library_grants, sessions, users},
    unix_now, CitadelStore, Result, StoreError,
};
use crate::Actor;

const USERNAME_MAX_CHARS: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct User {
    pub id: String,
    pub username: String,
}

impl User {
    pub fn actor(&self) -> Actor {
        Actor::User {
            id: self.id.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserSummary {
    pub user: User,
    pub has_password: bool,
    pub library_ids: Vec<String>,
}

impl CitadelStore {
    /// Creates a user with a sign-in password and a generated OPDS app password.
    pub fn create_user(&self, username: &str, password: &str) -> Result<User> {
        let username = validate_username(username)?;
        validate_password(password)?;
        let hash = hash_password(password)?;
        let user = User {
            id: uuid::Uuid::new_v4().to_string(),
            username,
        };
        let mut connection = self.connection();
        connection.immediate_transaction(|connection| {
            if find_user(connection, &user.username)?.is_some() {
                return Err(StoreError::Conflict(format!(
                    "A user named '{}' already exists.",
                    user.username
                )));
            }
            diesel::insert_into(users::table)
                .values((
                    users::id.eq(&user.id),
                    users::username.eq(&user.username),
                    users::password_hash.eq(Some(hash)),
                    users::app_password.eq(crate::password::generate_app_password()),
                    users::created_at.eq(unix_now()),
                ))
                .execute(connection)?;
            Ok(())
        })?;
        Ok(user)
    }

    pub fn users(&self) -> Result<Vec<UserSummary>> {
        let mut connection = self.connection();
        let rows = users::table
            .order(users::username)
            .select((
                users::id,
                users::username,
                users::password_hash.is_not_null(),
            ))
            .load::<(String, String, bool)>(&mut *connection)?;
        let grants = library_grants::table
            .order(library_grants::created_at)
            .select((library_grants::user_id, library_grants::library_id))
            .load::<(String, String)>(&mut *connection)?;
        Ok(rows
            .into_iter()
            .map(|(id, username, has_password)| UserSummary {
                library_ids: grants
                    .iter()
                    .filter(|(user_id, _)| *user_id == id)
                    .map(|(_, library_id)| library_id.clone())
                    .collect(),
                user: User { id, username },
                has_password,
            })
            .collect())
    }

    pub fn user(&self, username: &str) -> Result<User> {
        find_user(&mut self.connection(), username)?.ok_or_else(|| unknown_user(username))
    }

    pub fn remove_user(&self, username: &str) -> Result<()> {
        let user = self.user(username)?;
        diesel::delete(users::table.filter(users::id.eq(&user.id)))
            .execute(&mut *self.connection())?;
        Ok(())
    }

    /// Replaces the sign-in password and signs the user out everywhere.
    pub fn set_password(&self, username: &str, password: &str) -> Result<()> {
        validate_password(password)?;
        let user = self.user(username)?;
        let hash = hash_password(password)?;
        self.connection().immediate_transaction(|connection| {
            diesel::update(users::table.filter(users::id.eq(&user.id)))
                .set(users::password_hash.eq(Some(hash)))
                .execute(connection)?;
            diesel::delete(sessions::table.filter(sessions::user_id.eq(&user.id)))
                .execute(connection)?;
            Ok(())
        })
    }
}

fn find_user(connection: &mut SqliteConnection, username: &str) -> Result<Option<User>> {
    Ok(users::table
        .filter(users::username.eq(username.trim()))
        .select((users::id, users::username))
        .first::<(String, String)>(connection)
        .optional()?
        .map(|(id, username)| User { id, username }))
}

fn unknown_user(username: &str) -> StoreError {
    StoreError::NotFound(format!("No user named '{}'.", username.trim()))
}

fn validate_username(username: &str) -> Result<String> {
    let username = username.trim();
    if username.is_empty() {
        return Err(StoreError::Invalid("Usernames can't be empty.".into()));
    }
    if username.chars().count() > USERNAME_MAX_CHARS {
        return Err(StoreError::Invalid(format!(
            "Usernames can be at most {USERNAME_MAX_CHARS} characters."
        )));
    }
    // HTTP Basic (OPDS app passwords) splits `user:pass` at the first colon.
    if username.contains(':') || username.chars().any(char::is_control) {
        return Err(StoreError::Invalid(
            "Usernames can't contain a colon (:) or control characters.".into(),
        ));
    }
    Ok(username.to_string())
}

fn validate_password(password: &str) -> Result<()> {
    if password.chars().count() < 8 {
        return Err(StoreError::Invalid(
            "Sign-in passwords need at least 8 characters.".into(),
        ));
    }
    Ok(())
}

pub(super) fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut HashRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| StoreError::Storage(format!("could not hash password: {error}")))
}

#[cfg(test)]
mod tests {
    use super::super::test_support::store;
    use super::*;

    #[test]
    fn users_sign_in_with_hashed_passwords_and_names_are_case_insensitive() {
        let (_directory, store, _) = store();
        let alice = store.create_user(" alice ", "correct horse").unwrap();
        assert_eq!(alice.username, "alice");
        assert!(matches!(
            store.create_user("ALICE", "another password"),
            Err(StoreError::Conflict(_))
        ));
        assert_eq!(
            store.verify_password("Alice", "correct horse").unwrap(),
            Some(alice.clone())
        );
        assert_eq!(store.verify_password("alice", "wrong").unwrap(), None);
        assert_eq!(
            store.verify_password("nobody", "correct horse").unwrap(),
            None
        );
        let stored: Option<String> = users::table
            .select(users::password_hash)
            .first(&mut *store.connection())
            .unwrap();
        assert!(stored.unwrap().starts_with("$argon2id$"));
        for invalid in ["", "a:b", "tab\tname"] {
            assert!(matches!(
                store.create_user(invalid, "long enough"),
                Err(StoreError::Invalid(_))
            ));
        }
        assert!(store.create_user("bob", "short").is_err());
    }
}
