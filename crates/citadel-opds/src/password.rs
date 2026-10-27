//! Generated OPDS credentials. The password generator lives in citadel-core.

use serde::Serialize;

/// Returned when credentials are generated; the password is also stored
/// reversibly (ADR 0005) so the UI can reveal it again later.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedOpdsCredentials {
    pub username: String,
    pub password: String,
}

pub use citadel_core::password::generate_app_password as generate_password;
