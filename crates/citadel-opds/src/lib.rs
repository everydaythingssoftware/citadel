//! Tauri-independent OPDS catalog and asset streaming.

pub mod assets;
pub mod catalog;
mod identity;
mod xml;

pub use catalog::{router, CatalogSource};
