//! Outbound HTTP behind one seam. Code that talks to other services (metadata
//! providers, update checks) builds an [`HttpRequest`] and hands it to an
//! [`HttpClient`]; `citadel-host` supplies the real one, and tests answer
//! requests themselves instead of standing up servers.
use std::{fmt, future::Future, pin::Pin, time::Duration};

pub type HttpFuture<'a, TValue> =
    Pin<Box<dyn Future<Output = Result<TValue, HttpError>> + Send + 'a>>;

pub trait HttpClient: Send + Sync {
    fn send(&self, request: HttpRequest) -> HttpFuture<'static, HttpResponse>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpMethod {
    Get,
    Post,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpRequest {
    pub method: HttpMethod,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// The whole exchange, from connecting to the last byte of the headers.
    pub timeout: Option<Duration>,
    /// How many redirects the client follows itself; at 0 a redirect is
    /// returned as the response.
    pub follow_redirects: u8,
}

impl HttpRequest {
    pub fn get(url: impl Into<String>) -> Self {
        Self {
            method: HttpMethod::Get,
            url: url.into(),
            headers: Vec::new(),
            body: None,
            timeout: None,
            follow_redirects: 0,
        }
    }

    pub fn post(url: impl Into<String>, body: Vec<u8>) -> Self {
        Self {
            method: HttpMethod::Post,
            body: Some(body),
            ..Self::get(url)
        }
    }

    pub fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_ascii_lowercase(), value.into()));
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn follow_redirects(mut self, limit: u8) -> Self {
        self.follow_redirects = limit;
        self
    }
}

pub struct HttpResponse {
    pub status: u16,
    /// Names are lowercase.
    pub headers: Vec<(String, String)>,
    pub body: Box<dyn HttpBody>,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn is_redirect(&self) -> bool {
        (300..400).contains(&self.status)
    }

    pub fn content_length(&self) -> Option<u64> {
        self.header("content-length")?.trim().parse().ok()
    }

    /// The next part of the body, or `None` once it has all arrived.
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>, HttpError> {
        self.body.chunk().await
    }

    pub async fn bytes(mut self) -> Result<Vec<u8>, HttpError> {
        let mut bytes = Vec::new();
        while let Some(chunk) = self.chunk().await? {
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    pub async fn text(self) -> Result<String, HttpError> {
        String::from_utf8(self.bytes().await?)
            .map_err(|_| HttpError::other("the response wasn't UTF-8 text"))
    }
}

pub trait HttpBody: Send {
    fn chunk(&mut self) -> HttpFuture<'_, Option<Vec<u8>>>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpErrorKind {
    Timeout,
    /// Couldn't connect, or the connection broke.
    Connection,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HttpError {
    pub kind: HttpErrorKind,
    /// Never includes the request's URL, which can carry a user's query.
    pub message: String,
}

impl HttpError {
    pub fn new(kind: HttpErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn other(message: impl Into<String>) -> Self {
        Self::new(HttpErrorKind::Other, message)
    }
}

impl fmt::Display for HttpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for HttpError {}
