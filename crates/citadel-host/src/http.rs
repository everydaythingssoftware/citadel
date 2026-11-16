//! The operating system's side of [`HttpClient`], over reqwest.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use citadel_core::http::{
    HttpBody, HttpClient, HttpError, HttpErrorKind, HttpFuture, HttpMethod, HttpRequest,
    HttpResponse,
};

/// One connection pool per redirect limit asked for, since reqwest sets
/// redirects per client.
#[derive(Clone, Default)]
pub struct ReqwestHttp {
    clients: Arc<Mutex<HashMap<u8, reqwest::Client>>>,
}

impl ReqwestHttp {
    pub fn new() -> Self {
        Self::default()
    }

    fn client(&self, follow_redirects: u8) -> Result<reqwest::Client, HttpError> {
        let mut clients = self
            .clients
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(client) = clients.get(&follow_redirects) {
            return Ok(client.clone());
        }
        let policy = match follow_redirects {
            0 => reqwest::redirect::Policy::none(),
            limit => reqwest::redirect::Policy::limited(usize::from(limit)),
        };
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .redirect(policy)
            .build()
            .map_err(|error| HttpError::other(format!("could not set up HTTP: {error}")))?;
        clients.insert(follow_redirects, client.clone());
        Ok(client)
    }
}

impl HttpClient for ReqwestHttp {
    fn send(&self, request: HttpRequest) -> HttpFuture<'static, HttpResponse> {
        let client = self.client(request.follow_redirects);
        Box::pin(async move {
            let client = client?;
            let mut builder = match request.method {
                HttpMethod::Get => client.get(&request.url),
                HttpMethod::Post => client.post(&request.url),
            };
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            if let Some(body) = request.body {
                builder = builder.body(body);
            }
            if let Some(timeout) = request.timeout {
                builder = builder.timeout(timeout);
            }
            let response = builder.send().await.map_err(error)?;
            Ok(HttpResponse {
                status: response.status().as_u16(),
                headers: response
                    .headers()
                    .iter()
                    .filter_map(|(name, value)| {
                        Some((name.as_str().to_string(), value.to_str().ok()?.to_string()))
                    })
                    .collect(),
                body: Box::new(Body(response)),
            })
        })
    }
}

struct Body(reqwest::Response);

impl HttpBody for Body {
    fn chunk(&mut self) -> HttpFuture<'_, Option<Vec<u8>>> {
        Box::pin(async move {
            Ok(self
                .0
                .chunk()
                .await
                .map_err(error)?
                .map(|chunk| chunk.to_vec()))
        })
    }
}

/// Without the URL, which can carry a user's query.
fn error(error: reqwest::Error) -> HttpError {
    let kind = if error.is_timeout() {
        HttpErrorKind::Timeout
    } else if error.is_connect() || error.is_request() || error.is_body() {
        HttpErrorKind::Connection
    } else {
        HttpErrorKind::Other
    };
    HttpError::new(kind, error.without_url().to_string())
}
