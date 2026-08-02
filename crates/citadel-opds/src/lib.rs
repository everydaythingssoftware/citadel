//! Tauri-independent OPDS catalog, authentication, networking, and service lifecycle.

pub mod assets;
mod auth;
mod catalog;
mod credentials;
mod network;
mod service;

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
