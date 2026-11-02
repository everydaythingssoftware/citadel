use std::time::Duration;

use crate::error::MetadataError;

/// Upstream `Retry-After` values are capped so one bad header can't silence a
/// provider for hours.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(10 * 60);
const DEFAULT_RETRY_AFTER: Duration = Duration::from_secs(30);

/// One pooled client for every provider. Credentials are attached per
/// request, never stored on the client, so users' keys can't leak into each
/// other's requests.
#[derive(Clone)]
pub(crate) struct Http {
    client: reqwest::Client,
}

impl Http {
    pub fn new(user_agent: &str) -> Result<Self, MetadataError> {
        let client = reqwest::Client::builder()
            .user_agent(user_agent)
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::limited(3))
            .build()
            .map_err(|e| MetadataError::upstream(format!("Failed to build HTTP client: {e}")))?;
        Ok(Self { client })
    }

    pub fn get(&self, url: &str, timeout: Duration) -> reqwest::RequestBuilder {
        self.client.get(url).timeout(timeout)
    }

    pub fn post(&self, url: &str, timeout: Duration) -> reqwest::RequestBuilder {
        self.client.post(url).timeout(timeout)
    }

    /// GET a URL and return its body as text.
    pub async fn get_text(&self, url: &str, timeout: Duration) -> Result<String, MetadataError> {
        let response = send(self.get(url, timeout)).await?;
        response
            .text()
            .await
            .map_err(|e| MetadataError::upstream(format!("Failed to read response: {e}")))
    }

    /// GET a URL and decode its body as JSON into `T`.
    pub async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        timeout: Duration,
    ) -> Result<T, MetadataError> {
        let response = send(self.get(url, timeout)).await?;
        response
            .json::<T>()
            .await
            .map_err(|e| MetadataError::upstream(format!("Failed to parse response: {e}")))
    }
}

/// Send a request, mapping transport, timeout, rate-limit and non-2xx
/// responses to a descriptive error. Timeouts get a distinct message so the
/// UI can suggest trying another source.
pub(crate) async fn send(
    request: reqwest::RequestBuilder,
) -> Result<reqwest::Response, MetadataError> {
    let response = request.send().await.map_err(|e| {
        if e.is_timeout() {
            MetadataError::upstream("The source timed out — try another source.")
        } else {
            MetadataError::upstream(format!("Failed to reach source: {}", without_url(&e)))
        }
    })?;

    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(MetadataError::rate_limited(retry_after(&response)));
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(MetadataError::unauthorized(
            "The source rejected the API key — check it in settings.",
        ));
    }
    if !status.is_success() {
        return Err(MetadataError::upstream(format!(
            "Source returned status {status}"
        )));
    }
    Ok(response)
}

/// Request URLs can carry a user's query; keep them out of error messages.
fn without_url(error: &reqwest::Error) -> String {
    let mut message = error.to_string();
    if let Some(url) = error.url() {
        message = message.replace(&format!(" for url ({url})"), "");
    }
    message
}

fn retry_after(response: &reqwest::Response) -> Duration {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_RETRY_AFTER)
        .min(MAX_RETRY_AFTER)
}
