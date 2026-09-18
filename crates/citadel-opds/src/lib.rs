//! Framework-free OPDS catalog, authentication, networking, and service lifecycle for Citadel.

pub mod assets;
pub mod catalog;
mod identity;
pub mod network;
pub mod service;
mod xml;

pub use catalog::{router, CatalogSource};
pub use network::{OpdsInterfaceKind, OpdsInterfaceState, OpdsNetworkInterface};
pub use service::{
    OpdsBindTarget, OpdsErrorCode, OpdsLifecycleState, OpdsService, OpdsServiceStatus,
    OpdsStartConfig, OpdsStatusError,
};
