//! The shared listener against real sockets on an ephemeral port, with its
//! timeouts and caps shortened through `ListenerConfig`. Tests stand many
//! peers up on 127.0.0.1 by binding each client socket first and telling the
//! listener which address that source port stands for.
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    body::{Body, Bytes},
    extract::ConnectInfo,
    routing::get,
    Router,
};
use citadel_opds::{
    client::{resolve_client, ClientResolver, ForwardedHeader, IpRange, ProxyTrust},
    limits::{Capacities, Limits, RequestClass, StreamRules},
    listener::{serve_with, ListenerConfig, PeerAlias},
};
use futures_util::StreamExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpSocket, TcpStream},
    sync::oneshot,
};

#[derive(Clone, Default)]
struct Aliases(Arc<Mutex<HashMap<u16, IpAddr>>>);

impl Aliases {
    fn alias(&self) -> PeerAlias {
        let map = self.0.clone();
        Arc::new(
            move |peer: SocketAddr| match map.lock().unwrap().get(&peer.port()) {
                Some(address) => SocketAddr::new(*address, peer.port()),
                None => peer,
            },
        )
    }
}

struct Server {
    address: SocketAddr,
    aliases: Aliases,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

impl Server {
    async fn start(router: Router, clients: ClientResolver, config: ListenerConfig) -> Self {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let aliases = Aliases::default();
        let config = ListenerConfig {
            peer_alias: Some(aliases.alias()),
            ..config
        };
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(serve_with(listener, router, clients, config, async move {
            let _ = stopped.await;
        }));
        Self {
            address,
            aliases,
            stop: Some(stop),
            task,
        }
    }

    /// A connection the listener sees as coming from `from`, or from
    /// 127.0.0.1 itself.
    async fn connect(&self, from: Option<&str>) -> TcpStream {
        self.connect_with(from, None).await
    }

    async fn connect_with(&self, from: Option<&str>, receive_buffer: Option<u32>) -> TcpStream {
        let socket = TcpSocket::new_v4().unwrap();
        if let Some(size) = receive_buffer {
            socket.set_recv_buffer_size(size).unwrap();
        }
        socket.bind((Ipv4Addr::LOCALHOST, 0).into()).unwrap();
        if let Some(from) = from {
            let port = socket.local_addr().unwrap().port();
            self.aliases
                .0
                .lock()
                .unwrap()
                .insert(port, from.parse().unwrap());
        }
        socket.connect(self.address).await.unwrap()
    }

    async fn stop(mut self) {
        let _ = self.stop.take().unwrap().send(());
        tokio::time::timeout(Duration::from_secs(5), &mut self.task)
            .await
            .expect("graceful shutdown finishes")
            .unwrap()
            .unwrap();
    }
}

fn shortened() -> ListenerConfig {
    ListenerConfig {
        header_read_timeout: Duration::from_millis(300),
        idle_timeout: Duration::from_millis(1200),
        ..ListenerConfig::default()
    }
}

fn trusting(ranges: &[&str]) -> ClientResolver {
    ClientResolver::new(
        ProxyTrust::new(
            Some(ranges.iter().map(|r| IpRange::parse(r).unwrap()).collect()),
            Vec::new(),
        ),
        ForwardedHeader::XForwardedFor,
    )
}

fn app() -> Router {
    Router::new()
        .route("/", get(|| async { "hello" }))
        .route(
            "/peer",
            get(|ConnectInfo(peer): ConnectInfo<SocketAddr>| async move { peer.ip().to_string() }),
        )
        .route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                "late"
            }),
        )
}

const REQUEST: &[u8] = b"GET / HTTP/1.1\r\nHost: citadel\r\n\r\n";

/// Reads one small response (headers and a short body) off a keep-alive
/// connection.
async fn response(stream: &mut TcpStream) -> String {
    let mut buffer = vec![0; 4096];
    let mut text = String::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !(text.contains("\r\n\r\n") && body_complete(&text)) {
        let read = tokio::time::timeout_at(deadline.into(), stream.read(&mut buffer))
            .await
            .expect("a response in time")
            .unwrap();
        assert!(read > 0, "closed before answering: {text:?}");
        text.push_str(&String::from_utf8_lossy(&buffer[..read]));
    }
    text
}

fn body_complete(text: &str) -> bool {
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    head.lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|length| length.trim().parse::<usize>().unwrap())
        })
        .is_none_or(|length| body.len() >= length)
}

async fn ask(stream: &mut TcpStream, request: &[u8]) -> String {
    stream.write_all(request).await.unwrap();
    response(stream).await
}

/// Waits for the server to close `stream`, returning how long that took.
async fn closed_within(stream: &mut TcpStream, limit: Duration) -> Duration {
    let started = Instant::now();
    let mut buffer = [0; 1024];
    loop {
        match tokio::time::timeout(limit, stream.read(&mut buffer)).await {
            Err(_) => panic!("still open after {limit:?}"),
            Ok(Ok(0)) | Ok(Err(_)) => return started.elapsed(),
            Ok(Ok(_)) => {}
        }
    }
}

async fn refused(stream: &mut TcpStream) -> bool {
    let _ = stream.write_all(REQUEST).await;
    let mut buffer = [0; 64];
    match tokio::time::timeout(Duration::from_secs(2), stream.read(&mut buffer)).await {
        Ok(Ok(0)) | Ok(Err(_)) => true,
        Ok(Ok(_)) => false,
        Err(_) => panic!("neither answered nor closed"),
    }
}

#[tokio::test]
async fn a_request_head_that_stalls_is_closed_after_the_header_timeout() {
    let server = Server::start(app(), ClientResolver::loopback_only(), shortened()).await;
    let mut stream = server.connect(None).await;
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: citadel\r\n")
        .await
        .unwrap();
    let waited = closed_within(&mut stream, Duration::from_secs(3)).await;
    assert!(waited >= Duration::from_millis(200), "{waited:?}");

    let mut silent = server.connect(None).await;
    closed_within(&mut silent, Duration::from_secs(3)).await;
    server.stop().await;
}

#[tokio::test]
async fn an_idle_keep_alive_connection_outlives_the_header_timeout_then_closes() {
    let server = Server::start(app(), ClientResolver::loopback_only(), shortened()).await;
    let mut stream = server.connect(None).await;
    assert!(ask(&mut stream, REQUEST).await.ends_with("hello"));
    // Longer than the header timeout: idle connections aren't held to it.
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(ask(&mut stream, REQUEST).await.ends_with("hello"));
    let waited = closed_within(&mut stream, Duration::from_secs(4)).await;
    assert!(waited >= Duration::from_millis(900), "{waited:?}");
    server.stop().await;
}

#[tokio::test]
async fn every_request_carries_its_peer() {
    let server = Server::start(app(), ClientResolver::loopback_only(), shortened()).await;
    let mut stream = server.connect(Some("203.0.113.9")).await;
    let answer = ask(&mut stream, b"GET /peer HTTP/1.1\r\nHost: citadel\r\n\r\n").await;
    assert!(answer.ends_with("203.0.113.9"), "{answer}");
    server.stop().await;
}

#[tokio::test]
async fn one_untrusted_peer_may_hold_32_connections_and_others_still_get_in() {
    let server = Server::start(
        app(),
        trusting(&["172.18.0.0/16"]),
        ListenerConfig::default(),
    )
    .await;
    let mut held = Vec::new();
    for _ in 0..32 {
        let mut stream = server.connect(Some("203.0.113.9")).await;
        assert!(ask(&mut stream, REQUEST).await.ends_with("hello"));
        held.push(stream);
    }
    let mut extra = server.connect(Some("203.0.113.9")).await;
    assert!(refused(&mut extra).await, "the 33rd is refused");
    let mut other = server.connect(Some("203.0.113.10")).await;
    assert!(ask(&mut other, REQUEST).await.ends_with("hello"));

    drop(held.pop());
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut again = server.connect(Some("203.0.113.9")).await;
    assert!(
        ask(&mut again, REQUEST).await.ends_with("hello"),
        "a closed connection gives its place back"
    );
    server.stop().await;
}

#[tokio::test]
async fn a_trusted_proxy_is_not_capped_per_peer() {
    let server = Server::start(
        app(),
        trusting(&["172.18.0.0/16"]),
        ListenerConfig::default(),
    )
    .await;
    let mut held = Vec::new();
    for _ in 0..100 {
        let mut stream = server.connect(Some("172.18.0.5")).await;
        assert!(ask(&mut stream, REQUEST).await.ends_with("hello"));
        held.push(stream);
    }
    server.stop().await;
}

fn small_cap() -> ListenerConfig {
    ListenerConfig {
        max_connections: 8,
        loopback_reserved: 2,
        ..ListenerConfig::default()
    }
}

#[tokio::test]
async fn at_the_cap_a_new_connection_evicts_the_oldest_idle_one() {
    let server = Server::start(app(), ClientResolver::loopback_only(), small_cap()).await;
    let mut idle = Vec::new();
    for peer in 1..=6 {
        let mut stream = server.connect(Some(&format!("203.0.113.{peer}"))).await;
        assert!(ask(&mut stream, REQUEST).await.ends_with("hello"));
        idle.push(stream);
    }
    let mut newcomer = server.connect(Some("203.0.113.7")).await;
    assert!(ask(&mut newcomer, REQUEST).await.ends_with("hello"));
    closed_within(&mut idle[0], Duration::from_secs(2)).await;
    assert!(
        ask(&mut idle[1], REQUEST).await.ends_with("hello"),
        "only the oldest is evicted"
    );
    server.stop().await;
}

#[tokio::test]
async fn reserved_loopback_slots_let_a_health_check_in_when_the_cap_is_full() {
    let server = Server::start(app(), ClientResolver::loopback_only(), small_cap()).await;
    let mut busy = Vec::new();
    for peer in 1..=6 {
        let mut stream = server.connect(Some(&format!("203.0.113.{peer}"))).await;
        stream
            .write_all(b"GET /slow HTTP/1.1\r\nHost: citadel\r\n\r\n")
            .await
            .unwrap();
        busy.push(stream);
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut outsider = server.connect(Some("198.51.100.1")).await;
    assert!(
        refused(&mut outsider).await,
        "nothing idle to evict: refused"
    );
    let mut health = server.connect(None).await;
    assert!(ask(&mut health, REQUEST).await.ends_with("hello"));
    drop(busy);
    server.stop().await;
}

#[tokio::test]
async fn http2_prior_knowledge_is_refused() {
    let server = Server::start(app(), ClientResolver::loopback_only(), shortened()).await;
    let mut stream = server.connect(None).await;
    stream
        .write_all(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n\x00\x00\x00\x04\x00\x00\x00\x00\x00")
        .await
        .unwrap();
    let mut answer = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut answer)).await;
    // An HTTP/2 server would answer with a SETTINGS frame (type 4).
    assert!(
        answer.is_empty() || answer.starts_with(b"HTTP/1.1 "),
        "{:?}",
        String::from_utf8_lossy(&answer)
    );
    assert!(!answer.starts_with(b"HTTP/1.1 2"), "not served");
    server.stop().await;
}

#[tokio::test]
async fn oversized_headers_are_refused() {
    let server = Server::start(app(), ClientResolver::loopback_only(), shortened()).await;
    let mut stream = server.connect(None).await;
    let mut request = b"GET / HTTP/1.1\r\nHost: citadel\r\nX-Padding: ".to_vec();
    request.extend(std::iter::repeat_n(b'a', 40 * 1024));
    request.extend(b"\r\n\r\n");
    let _ = stream.write_all(&request).await;
    let mut answer = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut answer)).await;
    assert!(
        answer.starts_with(b"HTTP/1.1 431"),
        "{:?}",
        String::from_utf8_lossy(&answer)
    );
    server.stop().await;
}

#[tokio::test]
async fn a_trickling_download_gives_its_stream_slot_back() {
    let limits = Limits::with_rules(
        Capacities {
            public: 0,
            short: 4,
            stream: 1,
        },
        |_, path| {
            if path == "/download" {
                RequestClass::Stream
            } else {
                RequestClass::Short
            }
        },
        StreamRules {
            window: Duration::from_millis(400),
            min_bytes: 256 * 1024,
            upload_stall: Duration::from_secs(30),
        },
    );
    let clients = ClientResolver::loopback_only();
    let router = limits
        .admit(Router::new().route(
            "/download",
            get(|| async {
                let chunks = futures_util::stream::repeat_with(|| {
                    Ok::<_, std::io::Error>(Bytes::from(vec![b'x'; 64 * 1024]))
                })
                .take(1024);
                Body::from_stream(chunks)
            }),
        ))
        .layer(axum::middleware::from_fn_with_state(
            clients.clone(),
            resolve_client,
        ));
    let server = Server::start(router, clients, ListenerConfig::default()).await;
    let mut stream = server.connect_with(None, Some(4096)).await;
    stream
        .write_all(b"GET /download HTTP/1.1\r\nHost: citadel\r\n\r\n")
        .await
        .unwrap();
    let mut buffer = [0; 16];
    let read = stream.read(&mut buffer).await.unwrap();
    assert!(read > 0);
    assert_eq!(limits.available(RequestClass::Stream), 0, "downloading");
    let started = Instant::now();
    let mut closed = false;
    while started.elapsed() < Duration::from_secs(10) {
        if limits.available(RequestClass::Stream) == 1 {
            break;
        }
        match tokio::time::timeout(Duration::from_millis(100), stream.read(&mut buffer)).await {
            Ok(Ok(0)) | Ok(Err(_)) => {
                closed = true;
                break;
            }
            _ => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    assert_eq!(
        limits.available(RequestClass::Stream),
        1,
        "the slot came back after {:?}",
        started.elapsed()
    );
    if !closed {
        closed_within(&mut stream, Duration::from_secs(5)).await;
    }
    server.stop().await;
}

#[tokio::test]
async fn shutdown_closes_idle_connections_and_lets_requests_finish() {
    let router = Router::new().route(
        "/brief",
        get(|| async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            "done"
        }),
    );
    let server = Server::start(
        router,
        ClientResolver::loopback_only(),
        ListenerConfig::default(),
    )
    .await;
    let mut idle = server.connect(None).await;
    let mut working = server.connect(None).await;
    working
        .write_all(b"GET /brief HTTP/1.1\r\nHost: citadel\r\n\r\n")
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let stopping = tokio::spawn(server.stop());
    assert!(response(&mut working).await.ends_with("done"));
    closed_within(&mut idle, Duration::from_secs(2)).await;
    stopping.await.unwrap();
}
