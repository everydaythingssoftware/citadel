//! Framework-free OPDS catalog, authentication, networking, and service lifecycle for Citadel.

pub mod assets;
pub mod catalog;
mod identity;
pub mod network;
mod xml;

pub use catalog::{router, CatalogSource};
