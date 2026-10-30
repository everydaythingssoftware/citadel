use std::time::Duration;

/// Why a lookup failed. Hosts map the kind to their own error contract; the
/// message is user-facing and never includes a credential.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataError {
    pub kind: MetadataErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetadataErrorKind {
    /// The request itself is unusable (empty ISBN, missing key).
    InvalidArgument,
    /// The provider refused the credential.
    Unauthorized,
    /// Citadel or the provider asked us to slow down.
    RateLimited { retry_after: Duration },
    /// The provider is failing repeatedly and is skipped for a while.
    Unavailable { retry_after: Duration },
    /// The provider could not be reached or answered with something unusable.
    Upstream,
}

impl MetadataError {
    pub(crate) fn new(kind: MetadataErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new(MetadataErrorKind::InvalidArgument, message)
    }

    pub(crate) fn upstream(message: impl Into<String>) -> Self {
        Self::new(MetadataErrorKind::Upstream, message)
    }

    pub(crate) fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(MetadataErrorKind::Unauthorized, message)
    }

    pub(crate) fn rate_limited(retry_after: Duration) -> Self {
        Self::new(
            MetadataErrorKind::RateLimited { retry_after },
            format!(
                "This source is busy — try again in {}s.",
                retry_after.as_secs().max(1)
            ),
        )
    }

    pub(crate) fn unavailable(name: &str, retry_after: Duration) -> Self {
        Self::new(
            MetadataErrorKind::Unavailable { retry_after },
            format!(
                "{name} isn't responding — try another source, or this one again in {}s.",
                retry_after.as_secs().max(1)
            ),
        )
    }

    /// Whether this failure says the provider is unhealthy, as opposed to the
    /// request or credential being wrong.
    pub(crate) fn counts_against_provider(&self) -> bool {
        self.kind == MetadataErrorKind::Upstream
    }
}

impl std::fmt::Display for MetadataError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for MetadataError {}

impl From<MetadataError> for String {
    fn from(error: MetadataError) -> Self {
        error.message
    }
}
