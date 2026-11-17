use std::{sync::Arc, time::Duration};

use citadel_core::http::{HttpClient, HttpErrorKind, HttpRequest, HttpResponse};

use crate::error::MetadataError;

/// Upstream `Retry-After` values are capped so one bad header can't silence a
/// provider for hours.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(10 * 60);
const DEFAULT_RETRY_AFTER: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: u8 = 3;

/// One client for every provider. Credentials are attached per request,
/// never stored on the client, so users' keys can't leak into each other's
/// requests.
#[derive(Clone)]
pub(crate) struct Http {
    client: Arc<dyn HttpClient>,
    user_agent: String,
}

impl Http {
    pub fn new(client: Arc<dyn HttpClient>, user_agent: &str) -> Self {
        Self {
            client,
            user_agent: user_agent.to_string(),
        }
    }

    pub fn get(&self, url: &str, timeout: Duration) -> HttpRequest {
        self.identified(HttpRequest::get(url), timeout)
    }

    pub fn post_json(&self, url: &str, timeout: Duration, body: &serde_json::Value) -> HttpRequest {
        self.identified(
            HttpRequest::post(url, body.to_string().into_bytes()),
            timeout,
        )
        .header("content-type", "application/json")
    }

    fn identified(&self, request: HttpRequest, timeout: Duration) -> HttpRequest {
        request
            .header("user-agent", self.user_agent.clone())
            .timeout(timeout)
            .follow_redirects(MAX_REDIRECTS)
    }

    /// GET a URL and return its body as text.
    pub async fn get_text(&self, url: &str, timeout: Duration) -> Result<String, MetadataError> {
        text(self.send(self.get(url, timeout)).await?).await
    }

    /// GET a URL and decode its body as JSON into `T`.
    pub async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        timeout: Duration,
    ) -> Result<T, MetadataError> {
        let response = self.send(self.get(url, timeout)).await?;
        let bytes = response
            .bytes()
            .await
            .map_err(|e| MetadataError::upstream(format!("Failed to read response: {e}")))?;
        serde_json::from_slice(&bytes)
            .map_err(|e| MetadataError::upstream(format!("Failed to parse response: {e}")))
    }

    /// Send a request, mapping transport, timeout, rate-limit and non-2xx
    /// responses to a descriptive error. Timeouts get a distinct message so
    /// the UI can suggest trying another source.
    pub async fn send(&self, request: HttpRequest) -> Result<HttpResponse, MetadataError> {
        let response = self.client.send(request).await.map_err(|e| {
            if e.kind == HttpErrorKind::Timeout {
                MetadataError::upstream("The source timed out — try another source.")
            } else {
                MetadataError::upstream(format!("Failed to reach source: {e}"))
            }
        })?;

        let status = response.status;
        if status == 429 {
            return Err(MetadataError::rate_limited(retry_after(&response)));
        }
        if status == 401 || status == 403 {
            return Err(MetadataError::unauthorized(
                "The source rejected the API key — check it in settings.",
            ));
        }
        if !response.is_success() {
            return Err(MetadataError::upstream(format!(
                "Source returned status {status}"
            )));
        }
        Ok(response)
    }
}

pub(crate) async fn text(response: HttpResponse) -> Result<String, MetadataError> {
    response
        .text()
        .await
        .map_err(|e| MetadataError::upstream(format!("Failed to read response: {e}")))
}

fn retry_after(response: &HttpResponse) -> Duration {
    response
        .header("retry-after")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_RETRY_AFTER)
        .min(MAX_RETRY_AFTER)
}
