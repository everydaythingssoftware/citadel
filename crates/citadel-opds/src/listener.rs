//! The accept loop every Citadel listener uses: the JSON API and each OPDS
//! address (ADR 0017). HTTP/1.1 only, with header and idle timeouts, a cap on
//! header size, a global connection cap that evicts the oldest idle
//! connection, slots only loopback peers may use (so `citadel-server health`
//! always gets in), and a per-peer cap for peers that aren't trusted proxies.
//!
//! Hyper's own header-read timeout starts again whenever a keep-alive
//! connection goes idle, which would close idle connections after the header
//! timeout rather than the idle one, so both are kept here instead.
use std::{
    collections::{BTreeMap, HashMap},
    convert::Infallible,
    future::Future,
    io,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};

use axum::{
    body::{Body, Bytes, HttpBody},
    extract::ConnectInfo,
    Router,
};
use http_body::{Frame, SizeHint};
use hyper::{body::Incoming, server::conn::http1, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{watch, Notify},
    task::JoinSet,
    time::Instant,
};
use tower::ServiceExt;

use crate::client::ClientResolver;

/// A request's headers must arrive within this long of its first byte (or
/// of the connection opening).
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// A keep-alive connection with no request for this long is closed.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
pub const MAX_HEADER_BYTES: usize = 32 * 1024;
pub const MAX_CONNECTIONS: usize = 1024;
/// Of [`MAX_CONNECTIONS`], how many only loopback peers may use.
pub const LOOPBACK_RESERVED: usize = 32;
/// Connections one peer may hold, unless it is a trusted proxy.
pub const PER_PEER_CONNECTIONS: usize = 32;

/// Maps the address a connection came from to the one it is treated as.
#[doc(hidden)]
pub type PeerAlias = Arc<dyn Fn(SocketAddr) -> SocketAddr + Send + Sync>;

/// The listener's limits. Production uses [`ListenerConfig::default`];
/// tests shorten them.
#[derive(Clone)]
pub struct ListenerConfig {
    pub header_read_timeout: Duration,
    pub idle_timeout: Duration,
    pub max_header_bytes: usize,
    pub max_connections: usize,
    pub loopback_reserved: usize,
    pub per_peer: usize,
    /// Lets tests stand many peers up on one loopback address.
    #[doc(hidden)]
    pub peer_alias: Option<PeerAlias>,
}

impl Default for ListenerConfig {
    fn default() -> Self {
        Self {
            header_read_timeout: HEADER_READ_TIMEOUT,
            idle_timeout: IDLE_TIMEOUT,
            max_header_bytes: MAX_HEADER_BYTES,
            max_connections: MAX_CONNECTIONS,
            loopback_reserved: LOOPBACK_RESERVED,
            per_peer: PER_PEER_CONNECTIONS,
            peer_alias: None,
        }
    }
}

/// Lets a request's handlers close its connection, as admission does when
/// a transfer is too slow. In every request's extensions.
#[derive(Clone, Default)]
pub struct ConnectionControl {
    close: Arc<Notify>,
}

impl ConnectionControl {
    pub fn close(&self) {
        self.close.notify_one();
    }
}

/// Serves `router` on `listener` until `shutdown` resolves, then lets open
/// requests finish. Every request carries `ConnectInfo<SocketAddr>`.
/// `clients` says which peers are trusted proxies, exempt from the per-peer
/// cap.
pub async fn serve(
    listener: TcpListener,
    router: Router,
    clients: ClientResolver,
    shutdown: impl Future<Output = ()> + Send,
) -> io::Result<()> {
    serve_with(
        listener,
        router,
        clients,
        ListenerConfig::default(),
        shutdown,
    )
    .await
}

pub async fn serve_with(
    listener: TcpListener,
    router: Router,
    clients: ClientResolver,
    config: ListenerConfig,
    shutdown: impl Future<Output = ()> + Send,
) -> io::Result<()> {
    let table = Arc::new(Mutex::new(Table::default()));
    let (stopping, stop) = watch::channel(false);
    let mut connections = JoinSet::new();
    let mut shutdown = std::pin::pin!(shutdown);
    loop {
        let accepted = tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => accepted,
        };
        while connections.try_join_next().is_some() {}
        let (stream, peer) = match accepted {
            Ok(accepted) => accepted,
            Err(error) if transient(&error) => continue,
            Err(_) => {
                // Out of file descriptors and the like: back off, don't spin.
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let peer = match &config.peer_alias {
            Some(alias) => alias(peer),
            None => peer,
        };
        let address = peer.ip().to_canonical();
        let Some(slot) = Slot::admit(&table, &config, address, clients.trusts_peer(address)) else {
            drop(stream);
            continue;
        };
        let _ = stream.set_nodelay(true);
        connections.spawn(connection(
            stream,
            peer,
            slot,
            router.clone(),
            config.clone(),
            stop.clone(),
        ));
    }
    drop(listener);
    let _ = stopping.send(true);
    while connections.join_next().await.is_some() {}
    Ok(())
}

fn transient(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
    )
}

#[derive(Default)]
struct Table {
    next_id: u64,
    /// By age: ids only grow.
    open: BTreeMap<u64, Entry>,
    per_peer: HashMap<IpAddr, usize>,
}

struct Entry {
    address: IpAddr,
    activity: Arc<Activity>,
    evict: Arc<Notify>,
}

impl Table {
    fn remove(&mut self, id: u64) -> Option<Entry> {
        let entry = self.open.remove(&id)?;
        if let Some(count) = self.per_peer.get_mut(&entry.address) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.per_peer.remove(&entry.address);
            }
        }
        Some(entry)
    }
}

/// A connection's place in the table, given back when it closes.
struct Slot {
    table: Arc<Mutex<Table>>,
    id: u64,
    activity: Arc<Activity>,
    evict: Arc<Notify>,
}

impl Slot {
    fn admit(
        table: &Arc<Mutex<Table>>,
        config: &ListenerConfig,
        address: IpAddr,
        trusted: bool,
    ) -> Option<Self> {
        let mut locked = table.lock().unwrap();
        if !trusted && locked.per_peer.get(&address).copied().unwrap_or(0) >= config.per_peer {
            return None;
        }
        let limit = if address.is_loopback() {
            config.max_connections
        } else {
            config
                .max_connections
                .saturating_sub(config.loopback_reserved)
        };
        if locked.open.len() >= limit {
            let oldest_idle = locked
                .open
                .iter()
                .find(|(_, entry)| entry.activity.evictable())
                .map(|(id, _)| *id)?;
            if let Some(evicted) = locked.remove(oldest_idle) {
                evicted.evict.notify_one();
            }
        }
        let id = locked.next_id;
        locked.next_id += 1;
        let activity = Arc::new(Activity::new());
        let evict = Arc::new(Notify::new());
        locked.open.insert(
            id,
            Entry {
                address,
                activity: activity.clone(),
                evict: evict.clone(),
            },
        );
        *locked.per_peer.entry(address).or_default() += 1;
        Some(Self {
            table: table.clone(),
            id,
            activity,
            evict,
        })
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.table.lock().unwrap().remove(self.id);
    }
}

#[derive(Clone, Copy, Debug)]
enum Phase {
    /// Accepted; nothing read yet.
    Fresh(Instant),
    /// Part of a request's head has arrived.
    Head(Instant),
    /// This many requests are being answered.
    Busy(usize),
    /// Between keep-alive requests.
    Idle(Instant),
}

struct Activity {
    phase: Mutex<Phase>,
    /// Bytes read since the current request's head began.
    head_bytes: Mutex<usize>,
    changed: Notify,
}

impl Activity {
    fn new() -> Self {
        Self {
            phase: Mutex::new(Phase::Fresh(Instant::now())),
            head_bytes: Mutex::new(0),
            changed: Notify::new(),
        }
    }

    /// How much more may be read while waiting for a request's head.
    /// Hyper's own buffer limit can be overshot by a single large read, so
    /// reads are cut short here and hyper answers 431 once its buffer fills.
    fn head_allowance(&self, max: usize) -> Option<usize> {
        match *self.phase.lock().unwrap() {
            Phase::Busy(_) => None,
            Phase::Fresh(_) | Phase::Idle(_) => Some(max),
            Phase::Head(_) => Some(max.saturating_sub(*self.head_bytes.lock().unwrap())),
        }
    }

    fn update(&self, change: impl FnOnce(Phase) -> Phase) {
        let mut phase = self.phase.lock().unwrap();
        *phase = change(*phase);
        self.changed.notify_one();
    }

    fn read_bytes(&self, count: usize) {
        let mut phase = self.phase.lock().unwrap();
        let mut head_bytes = self.head_bytes.lock().unwrap();
        match *phase {
            Phase::Fresh(_) | Phase::Idle(_) => {
                *phase = Phase::Head(Instant::now());
                *head_bytes = count;
                self.changed.notify_one();
            }
            Phase::Head(_) => *head_bytes = head_bytes.saturating_add(count),
            Phase::Busy(_) => {}
        }
    }

    fn begin(&self) {
        self.update(|phase| match phase {
            Phase::Busy(count) => Phase::Busy(count + 1),
            _ => Phase::Busy(1),
        });
    }

    fn end(&self) {
        self.update(|phase| match phase {
            Phase::Busy(count) if count > 1 => Phase::Busy(count - 1),
            _ => Phase::Idle(Instant::now()),
        });
    }

    /// Nothing is in progress: safe to close.
    fn evictable(&self) -> bool {
        matches!(
            *self.phase.lock().unwrap(),
            Phase::Fresh(_) | Phase::Idle(_)
        )
    }

    /// When the connection should close if nothing changes.
    fn deadline(&self, config: &ListenerConfig) -> Option<Instant> {
        match *self.phase.lock().unwrap() {
            Phase::Fresh(since) | Phase::Head(since) => Some(since + config.header_read_timeout),
            Phase::Idle(since) => Some(since + config.idle_timeout),
            Phase::Busy(_) => None,
        }
    }
}

/// Ends a request's activity when its response body ends or is dropped.
struct Answering(Arc<Activity>);

impl Drop for Answering {
    fn drop(&mut self) {
        self.0.end();
    }
}

struct Tracked {
    body: Body,
    answering: Option<Answering>,
}

impl HttpBody for Tracked {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        let polled = Pin::new(&mut self.body).poll_frame(cx);
        if matches!(polled, Poll::Ready(None)) {
            self.answering = None;
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

/// A socket that reports when bytes arrive, and reads no more of a
/// request's head than `max_head` allows.
struct Watched {
    stream: TcpStream,
    activity: Arc<Activity>,
    max_head: usize,
}

impl AsyncRead for Watched {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let allowance = self
            .activity
            .head_allowance(self.max_head)
            .unwrap_or(usize::MAX)
            .min(buf.remaining());
        if allowance == 0 && buf.remaining() > 0 {
            // The head is over the limit and hyper has already refused it.
            return Poll::Ready(Ok(()));
        }
        let mut limited = buf.take(allowance);
        let polled = Pin::new(&mut self.stream).poll_read(cx, &mut limited);
        let read = limited.filled().len();
        if read > 0 {
            // SAFETY: `limited` covers `buf`'s unfilled part, and the read
            // initialised these `read` bytes of it.
            unsafe { buf.assume_init(read) };
            buf.advance(read);
            self.activity.read_bytes(read);
        }
        polled
    }
}

impl AsyncWrite for Watched {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.stream.is_write_vectored()
    }
}

async fn connection(
    stream: TcpStream,
    peer: SocketAddr,
    slot: Slot,
    router: Router,
    config: ListenerConfig,
    mut stop: watch::Receiver<bool>,
) {
    let activity = slot.activity.clone();
    let control = ConnectionControl::default();
    let service = {
        let activity = activity.clone();
        let control = control.clone();
        service_fn(move |mut request: hyper::Request<Incoming>| {
            activity.begin();
            let answering = Answering(activity.clone());
            request.extensions_mut().insert(ConnectInfo(peer));
            request.extensions_mut().insert(control.clone());
            let router = router.clone();
            async move {
                let response = match router.oneshot(request.map(Body::new)).await {
                    Ok(response) => response,
                    Err(never) => match never {},
                };
                Ok::<_, Infallible>(response.map(|body| {
                    Body::new(Tracked {
                        body,
                        answering: Some(answering),
                    })
                }))
            }
        })
    };
    let mut builder = http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(None)
        .keep_alive(true)
        .max_buf_size(config.max_header_bytes.max(8192));
    let io = TokioIo::new(Watched {
        stream,
        activity: activity.clone(),
        max_head: config.max_header_bytes.max(8192),
    });
    let connection = builder.serve_connection(io, service);
    let mut connection = std::pin::pin!(connection);
    let mut stopping = false;
    loop {
        let deadline = activity.deadline(&config);
        tokio::select! {
            _ = connection.as_mut() => break,
            _ = slot.evict.notified() => break,
            _ = control.close.notified() => break,
            _ = stop.changed(), if !stopping => {
                stopping = true;
                if activity.evictable() {
                    break;
                }
                connection.as_mut().graceful_shutdown();
            }
            _ = sleep_until(deadline) => {
                if activity.deadline(&config).is_some_and(|due| due <= Instant::now()) {
                    break;
                }
            }
            _ = activity.changed.notified() => {}
        }
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}
