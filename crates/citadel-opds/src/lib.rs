//! Framework-free OPDS catalog, authentication, networking, and service lifecycle for Citadel.

pub mod assets;
pub mod auth;
pub mod catalog;
pub mod credential_store;
mod identity;
mod limits;
pub mod network;
pub mod password;
pub mod service;
mod xml;

pub use catalog::{router, CatalogBookQuery, CatalogFacet, CatalogSource};
pub use service::{
    OpdsBindTarget, OpdsErrorCode, OpdsLifecycleState, OpdsService, OpdsServiceStatus,
    OpdsStartConfig, OpdsStatusError,
};
