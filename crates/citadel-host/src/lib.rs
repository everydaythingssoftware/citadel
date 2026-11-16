//! The operating system's side of Citadel's seams: [`SystemHost`] for
//! [`OpdsHost`] and [`ReqwestHttp`] for `citadel_core::http::HttpClient`. They
//! report what the computer has and do what they are asked; every decision is
//! made in the core crates, where it can be tested without a network.
use std::{
    io,
    net::{SocketAddr, TcpListener},
};

use citadel_opds::host::{
    HostInterface, HostInterfaceType, HostIpv6Address, ListenSocket, Listening, OpdsHost,
};
use netdev::interface::types::InterfaceType;
use tokio::sync::oneshot;

mod http;
pub use http::ReqwestHttp;

pub struct SystemHost;

impl OpdsHost for SystemHost {
    fn interfaces(&self) -> io::Result<Vec<HostInterface>> {
        Ok(netdev::get_interfaces()
            .into_iter()
            .map(|interface| HostInterface {
                interface_type: interface_type(interface.if_type),
                up: interface.is_up() && interface.is_running(),
                loopback: interface.is_loopback(),
                point_to_point: interface.is_point_to_point(),
                physical: interface.is_physical(),
                ipv4: interface
                    .ipv4
                    .iter()
                    .map(|network| network.addr())
                    .collect(),
                ipv6: interface
                    .ipv6
                    .iter()
                    .enumerate()
                    .map(|(index, network)| {
                        let flags = interface
                            .ipv6_addr_flags
                            .get(index)
                            .copied()
                            .unwrap_or_default();
                        HostIpv6Address {
                            address: network.addr(),
                            deprecated: flags.deprecated,
                            tentative: flags.tentative,
                            duplicated: flags.duplicated,
                        }
                    })
                    .collect(),
                name: interface.name,
                friendly_name: interface.friendly_name,
                description: interface.description,
            })
            .collect())
    }

    fn supports_ipv6(&self) -> bool {
        socket2::Socket::new(socket2::Domain::IPV6, socket2::Type::STREAM, None).is_ok()
    }

    fn listen(&self, socket: ListenSocket, app: axum::Router) -> io::Result<Listening> {
        let listener = tokio::net::TcpListener::from_std(bind(socket)?)?;
        let (shutdown, shutdown_received) = oneshot::channel();
        let stopped = tokio::spawn(async move {
            // Served on its own task, so a panic while serving ends only it.
            let _ = tokio::spawn(async move {
                let _ = axum::serve(listener, app)
                    .with_graceful_shutdown(async move {
                        let _ = shutdown_received.await;
                    })
                    .await;
            })
            .await;
        });
        Ok(Listening { shutdown, stopped })
    }
}

fn bind(socket: ListenSocket) -> io::Result<TcpListener> {
    let SocketAddr::V6(address) = socket.address else {
        let listener = TcpListener::bind(socket.address)?;
        listener.set_nonblocking(true)?;
        return Ok(listener);
    };
    let bound = socket2::Socket::new(
        socket2::Domain::IPV6,
        socket2::Type::STREAM,
        Some(socket2::Protocol::TCP),
    )?;
    bound.set_only_v6(socket.only_v6)?;
    bound.set_nonblocking(true)?;
    bound.bind(&socket2::SockAddr::from(address))?;
    bound.listen(1024)?;
    Ok(TcpListener::from(bound))
}

fn interface_type(interface_type: InterfaceType) -> HostInterfaceType {
    match interface_type {
        InterfaceType::Loopback => HostInterfaceType::Loopback,
        InterfaceType::Ethernet
        | InterfaceType::FastEthernetT
        | InterfaceType::FastEthernetFx
        | InterfaceType::GigabitEthernet => HostInterfaceType::Ethernet,
        InterfaceType::Wireless80211 => HostInterfaceType::Wireless,
        InterfaceType::Tunnel => HostInterfaceType::Tunnel,
        InterfaceType::Ppp => HostInterfaceType::Ppp,
        InterfaceType::ProprietaryVirtual => HostInterfaceType::Virtual,
        InterfaceType::Bridge => HostInterfaceType::Bridge,
        _ => HostInterfaceType::Other,
    }
}
