//! Tauri adapters for the shared `citadel-metadata` providers.

pub mod commands;

pub fn client() -> citadel_metadata::MetadataClient {
    citadel_metadata::MetadataClient::new(citadel_metadata::ClientOptions {
        version: env!("CARGO_PKG_VERSION").into(),
        contact: None,
    })
    .expect("metadata HTTP client builds")
}
