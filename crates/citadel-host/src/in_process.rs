//! Stand-ins for the operating system that run everything in-process, for
//! tests: [`RouterHttp`] answers HTTP requests from a router, and
//! [`InProcessHost`] keeps the routers OPDS asks it to serve instead of
//! opening sockets. Neither touches the network.
use std::{
    collections::HashMap,
    io,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use axum::{body::Body, Router};
use citadel_core::http::{
    HttpBody, HttpClient, HttpError, HttpErrorKind, HttpFuture, HttpMethod, HttpRequest,
    HttpResponse,
};
use citadel_opds::host::{HostInterface, ListenSocket, Listening, OpdsHost};
use tower::ServiceExt;

/// Answers every request from `router`, whatever host its URL names, as a
/// server on that host would, following redirects as the request asks.
#[derive(Clone)]
pub struct RouterHttp {
    router: Router,
}

impl RouterHttp {
    pub fn new(router: Router) -> Self {
        Self { router }
    }
}

impl HttpClient for RouterHttp {
    fn send(&self, request: HttpRequest) -> HttpFuture<'static, HttpResponse> {
        let router = self.router.clone();
        Box::pin(async move {
            let exchange = answer(router, request.clone());
            match request.timeout {
                Some(timeout) => tokio::time::timeout(timeout, exchange)
                    .await
                    .map_err(|_| HttpError::new(HttpErrorKind::Timeout, "timed out"))?,
                None => exchange.await,
            }
        })
    }
}

async fn answer(router: Router, mut request: HttpRequest) -> Result<HttpResponse, HttpError> {
    let mut redirects_left = request.follow_redirects;
    loop {
        let url = url::Url::parse(&request.url)
            .map_err(|error| HttpError::other(format!("invalid URL: {error}")))?;
        let mut builder = axum::http::Request::builder()
            .method(match request.method {
                HttpMethod::Get => "GET",
                HttpMethod::Post => "POST",
            })
            .uri(&url[url::Position::BeforePath..])
            .header(
                "host",
                &url[url::Position::BeforeHost..url::Position::AfterPort],
            );
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        let http_request = builder
            .body(Body::from(request.body.clone().unwrap_or_default()))
            .map_err(|error| HttpError::other(error.to_string()))?;
        let response = router
            .clone()
            .oneshot(http_request)
            .await
            .map_err(|error| HttpError::other(error.to_string()))?;
        let status = response.status().as_u16();
        let headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                Some((name.as_str().to_string(), value.to_str().ok()?.to_string()))
            })
            .collect();
        let location = headers
            .iter()
            .find(|(name, _)| name == "location")
            .map(|(_, value)| value.clone());
        if (300..400).contains(&status) && redirects_left > 0 {
            if let Some(location) = location {
                redirects_left -= 1;
                request.url = url
                    .join(&location)
                    .map_err(|error| HttpError::other(error.to_string()))?
                    .to_string();
                continue;
            }
        }
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .map_err(|error| HttpError::new(HttpErrorKind::Connection, error.to_string()))?;
        return Ok(HttpResponse {
            status,
            headers,
            body: Box::new(Whole(Some(body.to_vec()))),
        });
    }
}

struct Whole(Option<Vec<u8>>);

impl HttpBody for Whole {
    fn chunk(&mut self) -> HttpFuture<'_, Option<Vec<u8>>> {
        let chunk = self.0.take().filter(|bytes| !bytes.is_empty());
        Box::pin(async move { Ok(chunk) })
    }
}

/// A computer with the given interfaces whose sockets are routers kept in
/// memory: [`InProcessHost::router`] hands a test what OPDS serves at an
/// address.
#[derive(Clone, Default)]
pub struct InProcessHost {
    interfaces: Vec<HostInterface>,
    ipv6: bool,
    listening: Arc<Mutex<HashMap<SocketAddr, (ListenSocket, Router)>>>,
}

impl InProcessHost {
    pub fn new(interfaces: Vec<HostInterface>, ipv6: bool) -> Self {
        Self {
            interfaces,
            ipv6,
            listening: Arc::default(),
        }
    }

    /// What is being served at `address`, while it is.
    pub fn router(&self, address: SocketAddr) -> Option<Router> {
        self.lock().get(&address).map(|(_, router)| router.clone())
    }

    /// Every socket being served, with the options it was opened with.
    pub fn sockets(&self) -> Vec<ListenSocket> {
        let mut sockets: Vec<_> = self.lock().values().map(|(socket, _)| *socket).collect();
        sockets.sort_by_key(|socket| socket.address);
        sockets
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<SocketAddr, (ListenSocket, Router)>> {
        self.listening
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl OpdsHost for InProcessHost {
    fn interfaces(&self) -> io::Result<Vec<HostInterface>> {
        Ok(self.interfaces.clone())
    }

    fn supports_ipv6(&self) -> bool {
        self.ipv6
    }

    fn listen(&self, socket: ListenSocket, app: Router) -> io::Result<Listening> {
        let mut listening = self.lock();
        if listening.contains_key(&socket.address) {
            return Err(io::Error::from(io::ErrorKind::AddrInUse));
        }
        listening.insert(socket.address, (socket, app));
        let (shutdown, stopped) = tokio::sync::oneshot::channel::<()>();
        let served = self.listening.clone();
        let stopped = tokio::spawn(async move {
            let _ = stopped.await;
            served
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&socket.address);
        });
        Ok(Listening { shutdown, stopped })
    }
}
