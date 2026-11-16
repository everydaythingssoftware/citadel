//! What sharing needs from the operating system, behind one seam. The core
//! decides what to listen on and how; a host adapter (`citadel-host`) only
//! reports the computer's networks and opens the sockets it is asked for, so
//! tests can stand in for the operating system entirely.
use std::{io, net::SocketAddr};

use tokio::{sync::oneshot, task::JoinHandle};

pub use crate::network::{HostInterface, HostInterfaceType, HostIpv6Address};

pub trait OpdsHost: Send + Sync {
    /// The computer's network interfaces as the operating system reports them.
    fn interfaces(&self) -> io::Result<Vec<HostInterface>>;

    /// Whether the computer can listen on IPv6 at all. Sharing on every
    /// network listens on IPv6 too exactly when this is true.
    fn supports_ipv6(&self) -> bool;

    /// Opens `socket` and serves `app` on it until `Listening::shutdown` is
    /// sent or dropped; `Listening::stopped` completes once it has stopped.
    fn listen(&self, socket: ListenSocket, app: axum::Router) -> io::Result<Listening>;
}

/// A socket to open, with every option the core chose for it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ListenSocket {
    pub address: SocketAddr,
    /// IPv6 sockets take IPv6 only, so an IPv6 wildcard and an IPv4 wildcard
    /// can share a port (Linux would otherwise make the IPv6 one take both).
    pub only_v6: bool,
}

impl ListenSocket {
    pub(crate) fn for_address(address: SocketAddr) -> Self {
        Self {
            address,
            only_v6: address.is_ipv6(),
        }
    }
}

pub struct Listening {
    pub shutdown: oneshot::Sender<()>,
    pub stopped: JoinHandle<()>,
}
