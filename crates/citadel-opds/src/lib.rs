//! Tauri-independent OPDS catalog and asset streaming.

pub mod assets;
pub mod catalog;
pub mod network;
pub mod service;

pub use catalog::{router, CatalogSource};
pub use network::{
    OpdsInterfaceKind, OpdsInterfaceState, OpdsNetworkInterface,
};
pub use service::{
    OpdsBindTarget, OpdsErrorCode, OpdsLifecycleState, OpdsService, OpdsServiceStatus,
    OpdsStartConfig, OpdsStatusError,
};
