//! Settings Citadel keeps in `citadel.db` for itself (ADR 0017): proxy
//! ranges an administrator trusted in Settings, on top of the server's
//! `trustedProxies` (Citadel never writes its config file, so they live
//! here, one range per line), and the key known-device cookies are signed
//! with.
use diesel::prelude::*;
use rand_core::{OsRng, RngCore};

use super::{schema::properties, CitadelStore, Result};

const TRUSTED_PROXIES_PROPERTY: &str = "trusted_proxies";
/// The key known-device cookies are signed with (ADR 0017), hex-encoded.
const DEVICE_COOKIE_SECRET_PROPERTY: &str = "device_cookie_secret";

impl CitadelStore {
    /// The stored ranges, as they were saved.
    pub fn trusted_proxies(&self) -> Result<Vec<String>> {
        let value: Option<String> = properties::table
            .filter(properties::key.eq(TRUSTED_PROXIES_PROPERTY))
            .select(properties::value)
            .first(&mut *self.connection())
            .optional()?;
        Ok(value
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect())
    }

    /// The secret known-device cookies are signed with, made on first use
    /// and kept, so browsers stay known across restarts.
    pub fn device_cookie_secret(&self) -> Result<[u8; 32]> {
        let mut connection = self.connection();
        let read = |connection: &mut diesel::SqliteConnection| {
            properties::table
                .filter(properties::key.eq(DEVICE_COOKIE_SECRET_PROPERTY))
                .select(properties::value)
                .first::<String>(connection)
                .optional()
        };
        let parse = |value: &str| -> Option<[u8; 32]> {
            let bytes: Vec<u8> = (0..value.len())
                .step_by(2)
                .map(|index| u8::from_str_radix(value.get(index..index + 2)?, 16).ok())
                .collect::<Option<_>>()?;
            bytes.try_into().ok()
        };
        if let Some(secret) = read(&mut connection)?.as_deref().and_then(parse) {
            return Ok(secret);
        }
        let mut secret = [0u8; 32];
        OsRng.fill_bytes(&mut secret);
        let hex: String = secret.iter().map(|byte| format!("{byte:02x}")).collect();
        diesel::replace_into(properties::table)
            .values((
                properties::key.eq(DEVICE_COOKIE_SECRET_PROPERTY),
                properties::value.eq(hex),
            ))
            .execute(&mut *connection)?;
        Ok(secret)
    }

    /// Replaces the stored ranges; none removes the row.
    pub fn set_trusted_proxies(&self, ranges: &[String]) -> Result<()> {
        let mut connection = self.connection();
        if ranges.is_empty() {
            diesel::delete(properties::table.filter(properties::key.eq(TRUSTED_PROXIES_PROPERTY)))
                .execute(&mut *connection)?;
        } else {
            diesel::replace_into(properties::table)
                .values((
                    properties::key.eq(TRUSTED_PROXIES_PROPERTY),
                    properties::value.eq(ranges.join("\n")),
                ))
                .execute(&mut *connection)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::store;

    #[test]
    fn trusted_proxies_round_trip_and_clear() {
        let (_directory, store, _) = store();
        assert!(store.trusted_proxies().unwrap().is_empty());
        let ranges = vec!["172.18.0.5".to_string(), "10.0.0.0/8".to_string()];
        store.set_trusted_proxies(&ranges).unwrap();
        assert_eq!(store.trusted_proxies().unwrap(), ranges);
        store.set_trusted_proxies(&[]).unwrap();
        assert!(store.trusted_proxies().unwrap().is_empty());
    }

    #[test]
    fn the_device_cookie_secret_is_made_once_and_kept() {
        let (directory, store, _) = store();
        let secret = store.device_cookie_secret().unwrap();
        assert_ne!(secret, [0; 32]);
        assert_eq!(store.device_cookie_secret().unwrap(), secret);
        drop(store);
        let reopened =
            crate::store::CitadelStore::open(&directory.path().join("citadel.db")).unwrap();
        assert_eq!(reopened.device_cookie_secret().unwrap(), secret);
    }
}
