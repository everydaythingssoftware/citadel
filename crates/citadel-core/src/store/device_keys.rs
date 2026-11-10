//! OPDS device keys (ADR 0013): server-generated, named, one per reader
//! device. A key is shown once when created or rotated; only a salted SHA-256
//! is kept, which is enough for a long generated secret and cheap on every
//! OPDS request.
use diesel::prelude::*;
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use super::{
    libraries::known_library,
    schema::{device_keys, library_grants, users},
    unix_now, CitadelStore, Result, StoreError,
};

const NAME_MAX_CHARS: usize = 64;

/// What a user sees of a key after creating it: never the secret.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceKey {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

/// A key just created or rotated, with its secret, which is not kept.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NewDeviceKey {
    pub key: DeviceKey,
    pub username: String,
    pub secret: String,
}

/// What OPDS sign-in checks a username and key against.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeviceKeyVerifier {
    pub key_id: String,
    pub username: String,
    salt: String,
    key_hash: String,
}

impl DeviceKeyVerifier {
    /// A verifier for a secret held only in memory, for hosts and tests
    /// that serve readers without `citadel.db`.
    pub fn new(key_id: &str, username: &str, secret: &str) -> Self {
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let salt = hex(&salt);
        Self {
            key_id: key_id.to_string(),
            username: username.to_string(),
            key_hash: salted_hash(&salt, secret.as_bytes()),
            salt,
        }
    }

    /// Usernames match as browser sign-in matches them: trimmed, and ignoring
    /// ASCII case as `users.username COLLATE NOCASE` does. Constant time in the
    /// hash, so timing never shows how close a guess was.
    pub fn matches(&self, username: &str, key: &[u8]) -> bool {
        if !self.username.eq_ignore_ascii_case(username.trim()) {
            return false;
        }
        let given = salted_hash(&self.salt, key);
        bool::from(given.as_bytes().ct_eq(self.key_hash.as_bytes()))
    }
}

type KeyRow = (String, String, i64, Option<i64>);

fn key_from_row((id, name, created_at, last_used_at): KeyRow) -> DeviceKey {
    DeviceKey {
        id,
        name,
        created_at,
        last_used_at,
    }
}

type VerifierRow = (String, String, String, String);

fn verifier_from_row((key_id, username, salt, key_hash): VerifierRow) -> DeviceKeyVerifier {
    DeviceKeyVerifier {
        key_id,
        username,
        salt,
        key_hash,
    }
}

impl CitadelStore {
    pub fn device_keys(&self, username: &str) -> Result<Vec<DeviceKey>> {
        let user = self.user(username)?;
        Ok(device_keys::table
            .filter(device_keys::user_id.eq(&user.id))
            .order((device_keys::name, device_keys::created_at))
            .select((
                device_keys::id,
                device_keys::name,
                device_keys::created_at,
                device_keys::last_used_at,
            ))
            .load::<KeyRow>(&mut *self.connection())?
            .into_iter()
            .map(key_from_row)
            .collect())
    }

    /// Generates a key for one of the user's devices, e.g. "Kobo".
    pub fn create_device_key(&self, username: &str, name: &str) -> Result<NewDeviceKey> {
        let secret = crate::password::generate_app_password();
        self.add_device_key(username, name, &secret)
    }

    /// Keeps a secret the user already has, under `name`. Only for carrying
    /// over a password from before device keys; new keys are generated.
    pub fn import_device_key(
        &self,
        username: &str,
        name: &str,
        secret: &str,
    ) -> Result<NewDeviceKey> {
        if secret.is_empty() {
            return Err(StoreError::Invalid(
                "Device passwords can't be empty.".into(),
            ));
        }
        self.add_device_key(username, name, secret)
    }

    fn add_device_key(&self, username: &str, name: &str, secret: &str) -> Result<NewDeviceKey> {
        let user = self.user(username)?;
        let name = validate_name(name)?;
        let mut connection = self.connection();
        let key = connection.immediate_transaction(|connection| {
            if name_taken(connection, &user.id, &name)? {
                return Err(StoreError::Conflict(format!(
                    "{} already has a device password named '{name}'.",
                    user.username
                )));
            }
            insert_key(connection, &user.id, &name, secret)
        })?;
        Ok(NewDeviceKey {
            key,
            username: user.username,
            secret: secret.to_string(),
        })
    }

    /// Replaces the key with a new one of the same name in one step; the old
    /// key stops working at once.
    pub fn rotate_device_key(&self, username: &str, key_id: &str) -> Result<NewDeviceKey> {
        let user = self.user(username)?;
        let secret = crate::password::generate_app_password();
        let mut connection = self.connection();
        let key = connection.immediate_transaction(|connection| {
            let name = device_keys::table
                .filter(device_keys::id.eq(key_id))
                .filter(device_keys::user_id.eq(&user.id))
                .select(device_keys::name)
                .first::<String>(connection)
                .optional()?
                .ok_or_else(|| unknown_key(&user.username))?;
            diesel::delete(device_keys::table.filter(device_keys::id.eq(key_id)))
                .execute(connection)?;
            insert_key(connection, &user.id, &name, &secret)
        })?;
        Ok(NewDeviceKey {
            key,
            username: user.username,
            secret,
        })
    }

    pub fn revoke_device_key(&self, username: &str, key_id: &str) -> Result<()> {
        let user = self.user(username)?;
        let removed = diesel::delete(
            device_keys::table
                .filter(device_keys::id.eq(key_id))
                .filter(device_keys::user_id.eq(&user.id)),
        )
        .execute(&mut *self.connection())?;
        if removed == 0 {
            return Err(unknown_key(&user.username));
        }
        Ok(())
    }

    /// Records that the key just signed in. Callers throttle how often.
    pub fn touch_device_key(&self, key_id: &str) -> Result<()> {
        diesel::update(device_keys::table.filter(device_keys::id.eq(key_id)))
            .set(device_keys::last_used_at.eq(unix_now()))
            .execute(&mut *self.connection())?;
        Ok(())
    }

    /// The keys of every user who can see `library_id`.
    pub fn library_device_key_verifiers(&self, library_id: &str) -> Result<Vec<DeviceKeyVerifier>> {
        let mut connection = self.connection();
        known_library(&mut connection, library_id)?;
        Ok(device_keys::table
            .inner_join(users::table.inner_join(library_grants::table))
            .filter(library_grants::library_id.eq(library_id))
            .order((users::username, device_keys::name))
            .select((
                device_keys::id,
                users::username,
                device_keys::salt,
                device_keys::key_hash,
            ))
            .load::<VerifierRow>(&mut *connection)?
            .into_iter()
            .map(verifier_from_row)
            .collect())
    }

    /// One user's keys, whatever they're granted: the desktop shares
    /// whichever library is open with its local user's devices.
    pub fn user_device_key_verifiers(&self, username: &str) -> Result<Vec<DeviceKeyVerifier>> {
        let user = self.user(username)?;
        Ok(device_keys::table
            .inner_join(users::table)
            .filter(device_keys::user_id.eq(&user.id))
            .order(device_keys::name)
            .select((
                device_keys::id,
                users::username,
                device_keys::salt,
                device_keys::key_hash,
            ))
            .load::<VerifierRow>(&mut *self.connection())?
            .into_iter()
            .map(verifier_from_row)
            .collect())
    }
}

fn insert_key(
    connection: &mut SqliteConnection,
    user_id: &str,
    name: &str,
    secret: &str,
) -> Result<DeviceKey> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let salt = hex(&salt);
    let key = DeviceKey {
        id: uuid::Uuid::new_v4().simple().to_string(),
        name: name.to_string(),
        created_at: unix_now(),
        last_used_at: None,
    };
    diesel::insert_into(device_keys::table)
        .values((
            device_keys::id.eq(&key.id),
            device_keys::user_id.eq(user_id),
            device_keys::name.eq(&key.name),
            device_keys::key_hash.eq(salted_hash(&salt, secret.as_bytes())),
            device_keys::salt.eq(salt),
            device_keys::created_at.eq(key.created_at),
        ))
        .execute(connection)?;
    Ok(key)
}

fn name_taken(connection: &mut SqliteConnection, user_id: &str, name: &str) -> Result<bool> {
    Ok(diesel::select(diesel::dsl::exists(
        device_keys::table
            .filter(device_keys::user_id.eq(user_id))
            .filter(device_keys::name.eq(name)),
    ))
    .get_result(connection)?)
}

fn validate_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(StoreError::Invalid(
            "Name the device this password is for.".into(),
        ));
    }
    if name.chars().count() > NAME_MAX_CHARS || name.chars().any(char::is_control) {
        return Err(StoreError::Invalid(format!(
            "Device names can be at most {NAME_MAX_CHARS} characters, without control characters."
        )));
    }
    Ok(name.to_string())
}

fn unknown_key(username: &str) -> StoreError {
    StoreError::NotFound(format!("{username} has no such device password."))
}

/// `sha256(salt || key)`, the same as the migration computes in SQL.
fn salted_hash(salt: &str, key: &[u8]) -> String {
    let mut input = salt.as_bytes().to_vec();
    input.extend_from_slice(key);
    sha256_hex(&input)
}

pub(super) fn sha256_hex(input: &[u8]) -> String {
    hex(&Sha256::digest(input))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::super::test_support::store;
    use super::*;

    #[test]
    fn keys_are_hashed_named_rotated_and_revoked() {
        let (_directory, store, library) = store();
        store.create_user("alice", "correct horse").unwrap();
        assert!(store.device_keys("alice").unwrap().is_empty());
        let kobo = store.create_device_key("alice", " Kobo ").unwrap();
        assert_eq!(kobo.key.name, "Kobo");
        assert_eq!(kobo.username, "alice");
        let stored: (String, String) = device_keys::table
            .select((device_keys::salt, device_keys::key_hash))
            .first(&mut *store.connection())
            .unwrap();
        assert!(!stored.1.contains(&kobo.secret) && stored.0 != stored.1);
        assert!(matches!(
            store.create_device_key("alice", "kobo"),
            Err(StoreError::Conflict(_))
        ));
        assert!(matches!(
            store.create_device_key("alice", " "),
            Err(StoreError::Invalid(_))
        ));

        assert!(store
            .library_device_key_verifiers(&library.id)
            .unwrap()
            .is_empty());
        store
            .grant("alice", &library.id, super::super::LibraryPermission::Edit)
            .unwrap();
        let verifiers = store.library_device_key_verifiers(&library.id).unwrap();
        assert_eq!(verifiers.len(), 1);
        assert!(verifiers[0].matches("alice", kobo.secret.as_bytes()));
        assert!(!verifiers[0].matches("alice", b"wrong"));
        assert!(!verifiers[0].matches("bob", kobo.secret.as_bytes()));
        assert!(verifiers[0].matches("ALICE", kobo.secret.as_bytes()));
        assert!(verifiers[0].matches(" Alice ", kobo.secret.as_bytes()));

        let rotated = store.rotate_device_key("alice", &kobo.key.id).unwrap();
        assert_eq!(rotated.key.name, "Kobo");
        assert_ne!(rotated.key.id, kobo.key.id);
        assert_ne!(rotated.secret, kobo.secret);
        let verifiers = store.user_device_key_verifiers("alice").unwrap();
        assert_eq!(verifiers.len(), 1);
        assert!(!verifiers[0].matches("alice", kobo.secret.as_bytes()));
        assert!(verifiers[0].matches("alice", rotated.secret.as_bytes()));

        store.touch_device_key(&rotated.key.id).unwrap();
        assert!(store.device_keys("alice").unwrap()[0]
            .last_used_at
            .is_some());

        store.create_user("bob", "another password").unwrap();
        assert!(matches!(
            store.revoke_device_key("bob", &rotated.key.id),
            Err(StoreError::NotFound(_))
        ));
        store.revoke_device_key("alice", &rotated.key.id).unwrap();
        assert!(store.device_keys("alice").unwrap().is_empty());
        assert!(matches!(
            store.rotate_device_key("alice", &rotated.key.id),
            Err(StoreError::NotFound(_))
        ));

        store.create_device_key("alice", "Phone").unwrap();
        store.remove_user("alice").unwrap();
        assert_eq!(
            device_keys::table
                .count()
                .get_result::<i64>(&mut *store.connection())
                .unwrap(),
            0
        );
    }

    #[test]
    fn imported_secrets_verify_like_generated_ones() {
        let (_directory, store, _) = store();
        store.create_user("alice", "correct horse").unwrap();
        let imported = store
            .import_device_key("alice", "Existing password", "wren724=wolf")
            .unwrap();
        assert_eq!(imported.secret, "wren724=wolf");
        assert!(
            store.user_device_key_verifiers("alice").unwrap()[0].matches("alice", b"wren724=wolf")
        );
        assert!(store.import_device_key("alice", "Other", "").is_err());
    }
}
