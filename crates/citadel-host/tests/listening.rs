use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};

use citadel_host::SystemHost;
use citadel_opds::host::{ListenSocket, Listening, OpdsHost};

fn free_port() -> u16 {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn stop(listening: Listening) {
    let _ = listening.shutdown.send(());
    let _ = listening.stopped.await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ipv4_and_ipv6_wildcards_share_a_port() {
    if !SystemHost.supports_ipv6() {
        return;
    }
    let port = free_port();
    let v4 = SystemHost
        .listen(
            ListenSocket {
                address: SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port),
                only_v6: false,
            },
            axum::Router::new(),
        )
        .expect("v4 wildcard bind");
    let v6 = SystemHost
        .listen(
            ListenSocket {
                address: SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), port),
                only_v6: true,
            },
            axum::Router::new(),
        )
        .expect("v6 wildcard bind (only_v6 must be applied)");

    let _ = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stop(v4).await;
    stop(v6).await;
    drop(TcpListener::bind((Ipv4Addr::LOCALHOST, port)).unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn restarting_after_a_client_connection_releases_the_port() {
    let socket = ListenSocket {
        address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), free_port()),
        only_v6: false,
    };
    let first = SystemHost.listen(socket, axum::Router::new()).unwrap();
    // A client connects and the server closes first, leaving a connection
    // in TIME_WAIT on the server's side.
    let client = TcpStream::connect(socket.address).unwrap();
    stop(first).await;
    drop(client);

    let second = SystemHost
        .listen(socket, axum::Router::new())
        .expect("rebind after server-side close must not hit TIME_WAIT");
    stop(second).await;
}
