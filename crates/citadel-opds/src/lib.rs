//! Framework-free OPDS catalog, authentication, networking, and service lifecycle for Citadel.

pub mod assets;
pub mod auth;
pub mod catalog;
pub mod client;
pub mod credential_store;
mod identity;
pub mod limits;
pub mod listener;
pub mod network;
pub mod service;
mod xml;

pub use catalog::{
    asset_routes, router, router_with, CatalogBookQuery, CatalogFacet, CatalogSource,
};
pub use service::{
    OpdsBindTarget, OpdsErrorCode, OpdsLifecycleState, OpdsService, OpdsServiceStatus,
    OpdsStartConfig, OpdsStatusError,
};
