//! Framework-free OPDS catalog, authentication, networking, and service lifecycle for Citadel.

pub mod assets;
mod auth;
pub mod catalog;
pub mod credentials;
mod identity;
pub mod network;
pub mod service;
mod xml;

pub use auth::OpdsBasicAuth;
pub use catalog::{
    router, CatalogBookQuery, CatalogFacet, CatalogFilter, CatalogSort, CatalogSource,
};
pub use credentials::{GeneratedOpdsCredentials, OpdsCredentialStatus};
pub use network::{OpdsInterfaceKind, OpdsInterfaceState, OpdsNetworkInterface};
pub use service::{
    OpdsBindTarget, OpdsErrorCode, OpdsLifecycleState, OpdsService, OpdsServiceStatus,
    OpdsStartConfig, OpdsStatusError,
};
