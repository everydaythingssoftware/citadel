//! Proxy ranges an administrator trusted in Settings (ADR 0017), on top of
//! the server's `trustedProxies`. Citadel never writes its config file, so
//! they live here, one range per line.
use diesel::prelude::*;

use super::{schema::properties, CitadelStore, Result};

const TRUSTED_PROXIES_PROPERTY: &str = "trusted_proxies";

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
}
