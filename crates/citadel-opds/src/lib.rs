//! Framework-free OPDS catalog, authentication, networking, and service lifecycle for Citadel.

pub mod assets;
pub mod auth;
pub mod catalog;
pub mod client;
pub mod credential_store;
pub mod guard;
mod identity;
mod limits;
pub mod network;
pub mod service;
pub mod verifier;
mod xml;

pub use catalog::{router, CatalogBookQuery, CatalogFacet, CatalogSource};
pub use service::{
    OpdsBindTarget, OpdsErrorCode, OpdsLifecycleState, OpdsService, OpdsServiceStatus,
    OpdsStartConfig, OpdsStatusError,
};
