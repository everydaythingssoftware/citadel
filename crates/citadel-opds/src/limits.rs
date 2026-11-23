//! Admission: how many requests each listener serves at once, by class, and
//! how many each client may have in flight (ADR 0017). Every listener has its
//! own [`Limits`], so a flood on one never starves another.
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    task::{Context, Poll},
    time::Duration,
};

use axum::{
    body::{to_bytes, Body, Bytes, HttpBody},
    extract::{Request, State},
    http::{header, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Router,
};
use http_body::{Frame, SizeHint};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::{
    client::{AddressKey, ClientAddress},
    listener::ConnectionControl,
};

const BODY_BYTES: usize = 16 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);

/// What kind of work a request is, which decides the pool it waits in.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum RequestClass {
    /// The web app's own files and other answers anyone may fetch.
    Public,
    /// JSON and feeds: answered quickly.
    Short,
    /// Long transfers: downloads and uploads.
    Stream,
}

/// Decides a request's class from its method and path.
pub type Classifier = fn(&Method, &str) -> RequestClass;

/// Requests served at once in each class.
#[derive(Clone, Copy, Debug)]
pub struct Capacities {
    pub public: usize,
    pub short: usize,
    pub stream: usize,
}

pub const API_CAPACITIES: Capacities = Capacities {
    public: 32,
    short: 64,
    stream: 32,
};
pub const OPDS_CAPACITIES: Capacities = Capacities {
    public: 0,
    short: 48,
    stream: 24,
};

/// Requests one client may have in flight, multiplied by
/// [`SOFT_MODE_MULTIPLIER`] when it may stand for many people.
pub const CLIENT_PUBLIC_IN_FLIGHT: usize = 8;
pub const CLIENT_SHORT_IN_FLIGHT: usize = 16;
pub const CLIENT_STREAM_IN_FLIGHT: usize = 4;
pub const SOFT_MODE_MULTIPLIER: usize = 8;

/// How long transfers must keep moving.
#[derive(Clone, Copy, Debug)]
pub struct StreamRules {
    /// A response body sending less than `min_bytes` in any window this
    /// long ends.
    pub window: Duration,
    pub min_bytes: u64,
    /// A request body (an upload chunk) that sends nothing for this long
    /// ends.
    pub upload_stall: Duration,
}

impl Default for StreamRules {
    /// 1 KiB/s averaged over 60 s; 30 s without upload progress.
    fn default() -> Self {
        Self {
            window: Duration::from_secs(60),
            min_bytes: 60 * 1024,
            upload_stall: Duration::from_secs(30),
        }
    }
}

#[derive(Clone)]
pub struct Limits {
    inner: Arc<Inner>,
}

struct Inner {
    public: Arc<Semaphore>,
    short: Arc<Semaphore>,
    stream: Arc<Semaphore>,
    work: Arc<Semaphore>,
    clients: Mutex<HashMap<AddressKey, InFlight>>,
    classify: Classifier,
    deadline: Duration,
    rules: StreamRules,
}

#[derive(Default)]
struct InFlight {
    public: usize,
    short: usize,
    stream: usize,
}

pub(crate) struct WorkUnavailable;
impl IntoResponse for WorkUnavailable {
    fn into_response(self) -> Response {
        busy()
    }
}

/// OPDS: book files stream; feeds and covers are short.
pub fn opds_class(_method: &Method, path: &str) -> RequestClass {
    if path.starts_with("/opds/books/") && path.contains("/files/") {
        RequestClass::Stream
    } else {
        RequestClass::Short
    }
}

impl Limits {
    pub fn new(capacities: Capacities, classify: Classifier) -> Self {
        Self::with_rules(capacities, classify, StreamRules::default())
    }

    /// For tests, which can't wait a minute for a slow transfer to end.
    #[doc(hidden)]
    pub fn with_rules(capacities: Capacities, classify: Classifier, rules: StreamRules) -> Self {
        Self {
            inner: Arc::new(Inner {
                public: Arc::new(Semaphore::new(capacities.public)),
                short: Arc::new(Semaphore::new(capacities.short)),
                stream: Arc::new(Semaphore::new(capacities.stream)),
                // Every admitted request can hold one blocking job.
                work: Arc::new(Semaphore::new(capacities.short + capacities.stream)),
                clients: Mutex::default(),
                classify,
                deadline: DEADLINE,
                rules,
            }),
        }
    }

    /// One OPDS listener's limits.
    pub fn opds() -> Self {
        Self::new(OPDS_CAPACITIES, opds_class)
    }

    /// Admits `router`'s requests through these limits.
    pub fn admit<S: Clone + Send + Sync + 'static>(&self, router: Router<S>) -> Router<S> {
        router.layer(axum::middleware::from_fn_with_state(self.clone(), admit))
    }

    /// Free slots in `class`.
    pub fn available(&self, class: RequestClass) -> usize {
        self.pool(class).available_permits()
    }

    fn pool(&self, class: RequestClass) -> &Arc<Semaphore> {
        match class {
            RequestClass::Public => &self.inner.public,
            RequestClass::Short => &self.inner.short,
            RequestClass::Stream => &self.inner.stream,
        }
    }

    pub(crate) fn work_permit(&self) -> Result<OwnedSemaphorePermit, WorkUnavailable> {
        self.inner
            .work
            .clone()
            .try_acquire_owned()
            .map_err(|_| WorkUnavailable)
    }

    fn ticket(&self, class: RequestClass, client: &ClientAddress) -> Option<Ticket> {
        let multiplier = if client.is_soft() {
            SOFT_MODE_MULTIPLIER
        } else {
            1
        };
        let key = client.key();
        let counted = match class {
            RequestClass::Public => Some(CLIENT_PUBLIC_IN_FLIGHT * multiplier),
            RequestClass::Short => Some(CLIENT_SHORT_IN_FLIGHT * multiplier),
            RequestClass::Stream => Some(CLIENT_STREAM_IN_FLIGHT * multiplier),
        };
        if let Some(cap) = counted {
            let mut clients = self.inner.clients.lock().unwrap();
            let in_flight = clients.entry(key).or_default();
            let count = in_flight.count(class);
            if *count >= cap {
                return None;
            }
            *count += 1;
        }
        // Dropping the ticket gives the client's count back, permit or not.
        let mut ticket = Ticket {
            limits: self.inner.clone(),
            class,
            key: counted.map(|_| key),
            _permit: None,
        };
        ticket._permit = Some(self.pool(class).clone().try_acquire_owned().ok()?);
        Some(ticket)
    }
}

impl InFlight {
    fn count(&mut self, class: RequestClass) -> &mut usize {
        match class {
            RequestClass::Public => &mut self.public,
            RequestClass::Short => &mut self.short,
            RequestClass::Stream => &mut self.stream,
        }
    }
}

/// A request's admission: a slot in its class and its client's count.
struct Ticket {
    limits: Arc<Inner>,
    class: RequestClass,
    key: Option<AddressKey>,
    _permit: Option<OwnedSemaphorePermit>,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let Some(key) = self.key else { return };
        let mut clients = self.limits.clients.lock().unwrap();
        if let Some(in_flight) = clients.get_mut(&key) {
            let count = in_flight.count(self.class);
            *count = count.saturating_sub(1);
            if in_flight.public == 0 && in_flight.short == 0 && in_flight.stream == 0 {
                clients.remove(&key);
            }
        }
    }
}

pub(crate) fn busy() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::RETRY_AFTER, "1")],
        "Catalog busy",
    )
        .into_response()
}

pub(crate) async fn run_work<T: Send + 'static>(
    limits: &Limits,
    operation: impl FnOnce() -> T + Send + 'static,
) -> Result<T, WorkUnavailable> {
    let permit = limits.work_permit()?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|_| WorkUnavailable)
}

/// A request holds its slot until its response body ends or is dropped.
/// Every response body must keep moving: one slower than [`StreamRules`]
/// allow (a client that stops reading a large answer, say) ends, gives its
/// slot back and closes its connection. Upload bodies that stall end too.
/// Small answers fit in the socket's buffer, so they finish whatever the
/// client does. Body sizes and deadlines are each listener's own (see
/// [`bound_feeds`]).
async fn admit(State(limits): State<Limits>, request: Request, next: Next) -> Response {
    let class = (limits.inner.classify)(request.method(), request.uri().path());
    let client = ClientAddress::of(request.extensions());
    let Some(ticket) = limits.ticket(class, &client) else {
        return busy();
    };
    let rules = limits.inner.rules;
    let control = request.extensions().get::<ConnectionControl>().cloned();
    let request = if class == RequestClass::Stream {
        request.map(|body| Body::new(Stalling::new(body, rules.upload_stall)))
    } else {
        request
    };
    let (parts, body) = next.run(request).await.into_parts();
    Response::from_parts(parts, Body::new(Metered::new(body, ticket, rules, control)))
}

struct MeterShared {
    sent: AtomicU64,
    expired: AtomicBool,
    ticket: Mutex<Option<Ticket>>,
}

/// A response body that must average `min_bytes` per window. A
/// watchdog checks, since a client that stops reading stops the body being
/// polled at all; when it trips, the slot is released at once and the
/// connection closed.
struct Metered {
    body: Body,
    shared: Arc<MeterShared>,
    /// Stopped when the answer ends, so quick answers leave no timer behind.
    watchdog: tokio::task::JoinHandle<()>,
}

impl Drop for Metered {
    fn drop(&mut self) {
        self.watchdog.abort();
    }
}

impl Metered {
    fn new(
        body: Body,
        ticket: Ticket,
        rules: StreamRules,
        control: Option<ConnectionControl>,
    ) -> Self {
        let shared = Arc::new(MeterShared {
            sent: AtomicU64::new(0),
            expired: AtomicBool::new(false),
            ticket: Mutex::new(Some(ticket)),
        });
        let watchdog = tokio::spawn(watch_rate(Arc::downgrade(&shared), rules, control));
        Self {
            body,
            shared,
            watchdog,
        }
    }
}

/// Checks four times a window, over the latest window.
async fn watch_rate(
    shared: Weak<MeterShared>,
    rules: StreamRules,
    control: Option<ConnectionControl>,
) {
    const STEPS: usize = 4;
    let step = rules.window / STEPS as u32;
    let mut recent = VecDeque::with_capacity(STEPS);
    loop {
        tokio::time::sleep(step).await;
        let Some(shared) = shared.upgrade() else {
            return;
        };
        recent.push_back(shared.sent.swap(0, Ordering::AcqRel));
        if recent.len() > STEPS {
            recent.pop_front();
        }
        if recent.len() == STEPS && recent.iter().sum::<u64>() < rules.min_bytes {
            shared.expired.store(true, Ordering::Release);
            drop(shared.ticket.lock().unwrap().take());
            if let Some(control) = control {
                control.close();
            }
            return;
        }
    }
}

impl HttpBody for Metered {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        if self.shared.expired.load(Ordering::Acquire) {
            return Poll::Ready(Some(Err(axum::Error::new(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "transfer too slow",
            )))));
        }
        let polled = Pin::new(&mut self.body).poll_frame(cx);
        match &polled {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    self.shared
                        .sent
                        .fetch_add(data.len() as u64, Ordering::AcqRel);
                }
            }
            Poll::Ready(None) => {
                drop(self.shared.ticket.lock().unwrap().take());
                self.watchdog.abort();
            }
            _ => {}
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

/// A request body that errors once it has sent nothing for `stall`.
struct Stalling {
    body: Body,
    stall: Duration,
    timer: Pin<Box<tokio::time::Sleep>>,
}

impl Stalling {
    fn new(body: Body, stall: Duration) -> Self {
        Self {
            body,
            stall,
            timer: Box::pin(tokio::time::sleep(stall)),
        }
    }
}

impl HttpBody for Stalling {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, axum::Error>>> {
        match Pin::new(&mut self.body).poll_frame(cx) {
            Poll::Pending => {
                if self.timer.as_mut().poll(cx).is_ready() {
                    Poll::Ready(Some(Err(axum::Error::new(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "upload stalled",
                    )))))
                } else {
                    Poll::Pending
                }
            }
            ready => {
                let deadline = tokio::time::Instant::now() + self.stall;
                self.timer.as_mut().reset(deadline);
                ready
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

/// OPDS request bounds: catalog requests carry no meaningful body, so bodies
/// are capped small, and feeds must answer within the deadline. Downloads are
/// exempt from the deadline so slow readers can finish.
pub(crate) async fn bound_feeds(
    State(limits): State<Limits>,
    request: Request,
    next: Next,
) -> Response {
    let feed = !request.uri().path().starts_with("/opds/books/");
    let deadline = limits.inner.deadline;
    let (parts, body) = request.into_parts();
    // Bound even chunked bodies under a deadline.
    let body = match tokio::time::timeout(deadline, to_bytes(body, BODY_BYTES)).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        Err(_) => return busy(),
    };
    let request = Request::from_parts(parts, Body::from(body));
    if !feed {
        return next.run(request).await;
    }
    match tokio::time::timeout(deadline, next.run(request)).await {
        Ok(response) => response,
        Err(_) => busy(),
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;

    use super::*;
    use axum::{extract::connect_info::MockConnectInfo, routing::get};
    use tower::ServiceExt;

    const TINY: Capacities = Capacities {
        public: 1,
        short: 1,
        stream: 1,
    };

    impl Limits {
        fn with_deadline(capacities: Capacities, deadline: Duration) -> Self {
            let limits = Self::new(capacities, opds_class);
            let mut inner = Arc::try_unwrap(limits.inner).ok().unwrap();
            inner.deadline = deadline;
            Self {
                inner: Arc::new(inner),
            }
        }
    }

    fn opds(router: Router, limits: Limits) -> Router {
        limits.admit(router.layer(axum::middleware::from_fn_with_state(
            limits.clone(),
            bound_feeds,
        )))
    }

    fn app(limits: Limits) -> Router {
        opds(
            Router::new().route("/opds", get(|| async { "feed" })),
            limits,
        )
    }

    fn get_request(path: &str) -> Request {
        Request::builder().uri(path).body(Body::empty()).unwrap()
    }

    #[tokio::test]
    async fn response_body_holds_admission_until_dropped() {
        let limits = Limits::with_deadline(TINY, Duration::from_secs(1));
        let first = app(limits.clone())
            .oneshot(get_request("/opds"))
            .await
            .unwrap();
        let response = app(limits.clone())
            .oneshot(get_request("/opds"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::RETRY_AFTER], "1");
        drop(first);
        assert_eq!(limits.available(RequestClass::Short), 1);
        assert!(limits.inner.clients.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn each_client_has_its_own_in_flight_cap() {
        let limits = Limits::new(OPDS_CAPACITIES, opds_class);
        let from = |address: &str| {
            let peer: SocketAddr = format!("{address}:1").parse().unwrap();
            app(limits.clone()).layer(MockConnectInfo(peer))
        };
        let mut held = Vec::new();
        for _ in 0..CLIENT_SHORT_IN_FLIGHT {
            let response = from("203.0.113.9")
                .oneshot(get_request("/opds"))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            held.push(response);
        }
        let refused = from("203.0.113.9")
            .oneshot(get_request("/opds"))
            .await
            .unwrap();
        assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
        let other = from("203.0.113.10")
            .oneshot(get_request("/opds"))
            .await
            .unwrap();
        assert_eq!(other.status(), StatusCode::OK, "another client gets in");
        drop(held);
        let again = from("203.0.113.9")
            .oneshot(get_request("/opds"))
            .await
            .unwrap();
        assert_eq!(again.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn quick_answers_leave_no_watchdog_running() {
        let limits = Limits::new(
            Capacities {
                public: 0,
                short: 1000,
                stream: 0,
            },
            opds_class,
        );
        let app = limits.admit(Router::new().route("/opds", get(|| async { "feed" })));
        let alive = || {
            tokio::runtime::Handle::current()
                .metrics()
                .num_alive_tasks()
        };
        let before = alive();
        for _ in 0..100 {
            let response = app.clone().oneshot(get_request("/opds")).await.unwrap();
            axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
        }
        // Aborted watchdogs finish cancelling within moments; unaborted ones
        // would sleep for a quarter of the rate window (15 s).
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while alive() > before + 1 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            alive() <= before + 1,
            "{} tasks still alive",
            alive() - before
        );
    }

    #[tokio::test]
    async fn one_client_cant_take_every_public_slot() {
        let limits = Limits::new(
            Capacities {
                public: 100,
                short: 0,
                stream: 0,
            },
            |_, _| RequestClass::Public,
        );
        let app = limits.admit(Router::new().route("/app.js", get(|| async { "js" })));
        let from = |address: &str| {
            let peer: SocketAddr = format!("{address}:1").parse().unwrap();
            app.clone().layer(MockConnectInfo(peer))
        };
        let mut held = Vec::new();
        for _ in 0..CLIENT_PUBLIC_IN_FLIGHT {
            let response = from("203.0.113.9")
                .oneshot(get_request("/app.js"))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            held.push(response);
        }
        let refused = from("203.0.113.9")
            .oneshot(get_request("/app.js"))
            .await
            .unwrap();
        assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
        let other = from("203.0.113.10")
            .oneshot(get_request("/app.js"))
            .await
            .unwrap();
        assert_eq!(other.status(), StatusCode::OK, "another client gets in");
    }

    #[tokio::test]
    async fn soft_mode_clients_may_have_more_in_flight() {
        let limits = Limits::new(
            Capacities {
                public: 0,
                short: 1000,
                stream: 0,
            },
            opds_class,
        );
        let resolver = crate::client::ClientResolver::loopback_only();
        let router = axum::Router::new()
            .route("/opds", get(|| async { "feed" }))
            .layer(axum::middleware::from_fn_with_state(limits.clone(), admit))
            .layer(axum::middleware::from_fn_with_state(
                resolver,
                crate::client::resolve_client,
            ))
            .layer(MockConnectInfo(SocketAddr::from(([192, 168, 1, 30], 1))));
        let mut held = Vec::new();
        for _ in 0..CLIENT_SHORT_IN_FLIGHT * SOFT_MODE_MULTIPLIER {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/opds")
                        .header("x-forwarded-for", "198.51.100.1")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            held.push(response);
        }
        let refused = router.oneshot(get_request("/opds")).await.unwrap();
        assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn classes_have_their_own_pools() {
        let limits = Limits::new(TINY, opds_class);
        let router = limits.admit(
            Router::new()
                .route("/opds", get(|| async { "feed" }))
                .route(
                    "/opds/books/1/files/EPUB/book.epub",
                    get(|| async { "book" }),
                ),
        );
        let feed = router.clone().oneshot(get_request("/opds")).await.unwrap();
        let download = router
            .clone()
            .oneshot(get_request("/opds/books/1/files/EPUB/book.epub"))
            .await
            .unwrap();
        assert_eq!(feed.status(), StatusCode::OK);
        assert_eq!(
            download.status(),
            StatusCode::OK,
            "feeds don't block downloads"
        );
        assert_eq!(limits.available(RequestClass::Short), 0);
        assert_eq!(limits.available(RequestClass::Stream), 0);
    }

    #[tokio::test]
    async fn a_stalled_upload_ends() {
        let limits = Limits::with_rules(
            TINY,
            |_, _| RequestClass::Stream,
            StreamRules {
                upload_stall: Duration::from_millis(50),
                ..StreamRules::default()
            },
        );
        let router = limits.admit(Router::new().route(
            "/upload",
            axum::routing::put(|body: Body| async move {
                match to_bytes(body, 1024).await {
                    Ok(bytes) => (StatusCode::OK, bytes.len().to_string()),
                    Err(_) => (StatusCode::REQUEST_TIMEOUT, "stalled".to_string()),
                }
            }),
        ));
        let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(1);
        sender.send(Ok(Bytes::from_static(b"some"))).await.unwrap();
        let body = Body::from_stream(futures_util::stream::unfold(
            receiver,
            |mut receiver| async move { receiver.recv().await.map(|item| (item, receiver)) },
        ));
        let response = router
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/upload")
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
        drop(sender);
    }

    #[tokio::test]
    async fn body_limit_covers_declared_and_chunked_bodies() {
        for declared in [false, true] {
            let mut request = Request::builder().uri("/opds");
            if declared {
                request = request.header(header::CONTENT_LENGTH, BODY_BYTES + 1);
            }
            let chunks = futures_util::stream::iter([
                Ok::<_, std::io::Error>(vec![b'x'; BODY_BYTES]),
                Ok(vec![b'x']),
            ]);
            let response = app(Limits::opds())
                .oneshot(request.body(Body::from_stream(chunks)).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        }
    }

    #[tokio::test]
    async fn admission_alone_leaves_bodies_to_the_listener() {
        let router = Limits::opds().admit(Router::new().route(
            "/api/echo",
            axum::routing::post(|body: axum::body::Bytes| async move { body.len().to_string() }),
        ));
        let response = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/echo")
                    .body(Body::from(vec![b'x'; BODY_BYTES * 4]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), 100).await.unwrap(),
            (BODY_BYTES * 4).to_string()
        );
    }

    #[tokio::test]
    async fn timed_out_blocking_job_retains_its_work_slot() {
        let limits = Limits::with_deadline(
            Capacities {
                public: 0,
                short: 1,
                stream: 0,
            },
            Duration::from_millis(5),
        );
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let copy = limits.clone();
        let task = tokio::spawn(async move {
            run_work(&copy, move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            })
            .await
        });
        started_rx.await.unwrap();
        task.abort();
        let _ = task.await;
        assert!(run_work(&limits, || ()).await.is_err());
        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while limits.inner.work.available_permits() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(run_work(&limits, || ()).await.is_ok());
    }

    #[tokio::test]
    async fn feed_deadline_does_not_cut_off_slow_successful_downloads() {
        let limits = Limits::with_deadline(
            Capacities {
                public: 0,
                short: 2,
                stream: 2,
            },
            Duration::from_millis(5),
        );
        let router = Router::new()
            .route(
                "/opds",
                get(|| async {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    "feed"
                }),
            )
            .route(
                "/opds/books/1/cover",
                get(|| async {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    "cover-bytes"
                }),
            );
        let router = opds(router, limits);
        let feed = router.clone().oneshot(get_request("/opds")).await.unwrap();
        assert_eq!(feed.status(), StatusCode::SERVICE_UNAVAILABLE);
        let asset = router
            .oneshot(get_request("/opds/books/1/cover"))
            .await
            .unwrap();
        assert_eq!(asset.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(asset.into_body(), 100).await.unwrap(),
            "cover-bytes"
        );
    }
}
