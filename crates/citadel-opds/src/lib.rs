//! Tauri-independent OPDS catalog and asset streaming.

pub mod assets;
pub mod catalog;

pub use catalog::{router, CatalogSource};
