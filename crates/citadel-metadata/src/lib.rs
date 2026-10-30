//! Book-metadata providers. Hardcover (GraphQL), Library of Congress, the
//! Deutsche Nationalbibliothek and K10plus (SRU/MARCXML), and Open Library
//! (JSON-REST) all return the unified [`BookMetadata`] from a single search
//! call. The desktop and the server share one [`MetadataClient`] each; see
//! `docs/adr/0010-metadata-lookup-on-the-server.md`.
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

mod error;
mod guard;
mod http;
pub mod model;
mod providers;

pub use error::{MetadataError, MetadataErrorKind};
pub use model::{BookMetadata, GenreCandidate, MetadataProvider, ProviderStatus};

use providers::{hardcover, openlibrary, source, sru};

/// A clean ISBN miss is remembered this long, so re-importing a book no
/// source knows doesn't ask every source again.
const MISS_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_MISSES: usize = 2048;

/// How the client identifies itself to providers.
#[derive(Clone, Debug, Default)]
pub struct ClientOptions {
    /// The host application's version, sent as `Citadel/<version>`.
    pub version: String,
    /// An operator contact (URL or email) appended to the User-Agent, as
    /// Open Library asks of heavy clients.
    pub contact: Option<String>,
}

/// Where each provider lives. Only tests point these anywhere else.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub openlibrary: String,
    pub hardcover: String,
    pub loc: String,
    pub dnb: String,
    pub k10plus: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        let sru = |provider| {
            source::endpoint(provider)
                .expect("SRU providers have endpoints")
                .base_url
                .to_string()
        };
        Self {
            openlibrary: openlibrary::BASE_URL.into(),
            hardcover: hardcover::API_URL.into(),
            loc: sru(MetadataProvider::Loc),
            dnb: sru(MetadataProvider::Dnb),
            k10plus: sru(MetadataProvider::K10plus),
        }
    }
}

impl Endpoints {
    fn sru(&self, provider: MetadataProvider) -> &str {
        match provider {
            MetadataProvider::Loc => &self.loc,
            MetadataProvider::Dnb => &self.dnb,
            _ => &self.k10plus,
        }
    }
}

pub fn user_agent(options: &ClientOptions) -> String {
    let contact = options
        .contact
        .as_deref()
        .map(|contact| contact.trim())
        .filter(|contact| !contact.is_empty())
        .map(|contact| format!("; {contact}"))
        .unwrap_or_default();
    format!("Citadel/{} (+metadata-lookup{contact})", options.version)
}

/// Looks books up for every user of one Citadel process. Cheap to share
/// behind an `Arc`; credentials are passed per call and never retained.
pub struct MetadataClient {
    http: http::Http,
    guards: guard::Guards,
    endpoints: Endpoints,
    misses: Mutex<HashMap<(MetadataProvider, String), Instant>>,
}

impl MetadataClient {
    pub fn new(options: ClientOptions) -> Result<Self, MetadataError> {
        Self::with_endpoints(options, Endpoints::default())
    }

    pub fn with_endpoints(
        options: ClientOptions,
        endpoints: Endpoints,
    ) -> Result<Self, MetadataError> {
        Ok(Self {
            http: http::Http::new(&user_agent(&options))?,
            guards: guard::Guards::new(),
            endpoints,
            misses: Mutex::default(),
        })
    }

    /// Free-text search a provider. A clean "no results" is `Ok(vec![])`.
    pub async fn search(
        &self,
        provider: MetadataProvider,
        query: &str,
        credential: Option<&str>,
    ) -> Result<Vec<BookMetadata>, MetadataError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let credential = require_credential(provider, credential)?;
        self.guards
            .run(provider, credential, || async {
                match provider {
                    MetadataProvider::Hardcover => {
                        hardcover::search(
                            &self.http,
                            &self.endpoints.hardcover,
                            credential.unwrap_or_default(),
                            query,
                        )
                        .await
                    }
                    MetadataProvider::Loc | MetadataProvider::Dnb | MetadataProvider::K10plus => {
                        sru::search(
                            &self.http,
                            self.endpoints.sru(provider),
                            sru_endpoint(provider),
                            query,
                            None,
                        )
                        .await
                    }
                    MetadataProvider::OpenLibrary => {
                        openlibrary::search(&self.http, &self.endpoints.openlibrary, query).await
                    }
                }
            })
            .await
    }

    /// Look a provider up by ISBN. A clean "no match" is `Ok(vec![])`.
    pub async fn by_isbn(
        &self,
        provider: MetadataProvider,
        isbn: &str,
        credential: Option<&str>,
    ) -> Result<Vec<BookMetadata>, MetadataError> {
        let isbn = isbn.trim();
        if isbn.is_empty() {
            return Err(MetadataError::invalid("ISBN is empty"));
        }
        let credential = require_credential(provider, credential)?;
        let miss_key = (
            provider,
            model::canonical_isbn13(isbn).unwrap_or_else(|| isbn.to_string()),
        );
        if self.recently_missed(&miss_key, Instant::now()) {
            return Ok(Vec::new());
        }
        let books = self
            .guards
            .run(provider, credential, || async {
                match provider {
                    MetadataProvider::Hardcover => {
                        hardcover::search_by_isbn(
                            &self.http,
                            &self.endpoints.hardcover,
                            credential.unwrap_or_default(),
                            isbn,
                        )
                        .await
                    }
                    MetadataProvider::Loc | MetadataProvider::Dnb | MetadataProvider::K10plus => {
                        sru::search(
                            &self.http,
                            self.endpoints.sru(provider),
                            sru_endpoint(provider),
                            "",
                            Some(isbn),
                        )
                        .await
                    }
                    MetadataProvider::OpenLibrary => {
                        openlibrary::search_by_isbn(&self.http, &self.endpoints.openlibrary, isbn)
                            .await
                    }
                }
            })
            .await?;
        if books.is_empty() {
            self.note_miss(miss_key, Instant::now());
        }
        Ok(books)
    }

    /// Check that a provider is reachable and the credential, if it needs
    /// one, is accepted. Returns the provider account's name when it has one.
    pub async fn test(
        &self,
        provider: MetadataProvider,
        credential: Option<&str>,
    ) -> Result<Option<String>, MetadataError> {
        let credential = require_credential(provider, credential)?;
        self.guards
            .run(provider, credential, || async {
                match provider {
                    MetadataProvider::Hardcover => {
                        hardcover::test(
                            &self.http,
                            &self.endpoints.hardcover,
                            credential.unwrap_or_default(),
                        )
                        .await
                    }
                    MetadataProvider::Loc | MetadataProvider::Dnb | MetadataProvider::K10plus => {
                        sru::search(
                            &self.http,
                            self.endpoints.sru(provider),
                            sru_endpoint(provider),
                            "test",
                            None,
                        )
                        .await
                        .map(|_| None)
                    }
                    MetadataProvider::OpenLibrary => {
                        openlibrary::test(&self.http, &self.endpoints.openlibrary)
                            .await
                            .map(|_| None)
                    }
                }
            })
            .await
    }

    fn recently_missed(&self, key: &(MetadataProvider, String), now: Instant) -> bool {
        self.misses
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(key)
            .is_some_and(|missed_at| now.saturating_duration_since(*missed_at) < MISS_TTL)
    }

    fn note_miss(&self, key: (MetadataProvider, String), now: Instant) {
        let mut misses = self
            .misses
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if misses.len() >= MAX_MISSES {
            misses.retain(|_, missed_at| now.saturating_duration_since(*missed_at) < MISS_TTL);
            if misses.len() >= MAX_MISSES {
                misses.clear();
            }
        }
        misses.insert(key, now);
    }
}

fn sru_endpoint(provider: MetadataProvider) -> &'static source::SruEndpoint {
    source::endpoint(provider).expect("SRU providers have endpoints")
}

/// Keyed providers need a non-empty credential; keyless ones ignore any.
fn require_credential(
    provider: MetadataProvider,
    credential: Option<&str>,
) -> Result<Option<&str>, MetadataError> {
    if !provider.requires_key() {
        return Ok(None);
    }
    match credential.map(str::trim).filter(|key| !key.is_empty()) {
        Some(key) => Ok(Some(key)),
        None => Err(MetadataError::invalid("API key is empty")),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use axum::{extract::State, routing::get, Router};

    use super::*;

    async fn serve(router: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await });
        format!("http://{address}")
    }

    fn client(openlibrary: String) -> MetadataClient {
        MetadataClient::with_endpoints(
            ClientOptions {
                version: "test".into(),
                contact: None,
            },
            Endpoints {
                openlibrary,
                ..Endpoints::default()
            },
        )
        .unwrap()
    }

    #[test]
    fn user_agent_names_the_operator_contact() {
        let mut options = ClientOptions {
            version: "1.2.3".into(),
            contact: None,
        };
        assert_eq!(user_agent(&options), "Citadel/1.2.3 (+metadata-lookup)");
        options.contact = Some(" admin@example.com ".into());
        assert_eq!(
            user_agent(&options),
            "Citadel/1.2.3 (+metadata-lookup; admin@example.com)"
        );
    }

    #[tokio::test]
    async fn keyed_providers_refuse_an_empty_credential_before_any_request() {
        let client = client("http://127.0.0.1:9".into());
        for credential in [None, Some(""), Some("  ")] {
            let error = client
                .search(MetadataProvider::Hardcover, "dune", credential)
                .await
                .unwrap_err();
            assert_eq!(error.kind, MetadataErrorKind::InvalidArgument);
        }
    }

    #[tokio::test]
    async fn isbn_misses_are_remembered_across_isbn_forms() {
        let hits = Arc::new(AtomicUsize::new(0));
        let base = serve(
            Router::new()
                .route(
                    "/api/books",
                    get(|State(hits): State<Arc<AtomicUsize>>| async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        axum::Json(serde_json::json!({}))
                    }),
                )
                .with_state(hits.clone()),
        )
        .await;
        let client = client(base);
        for isbn in ["9780553103540", "0553103547", "978-0-553-10354-0"] {
            assert!(client
                .by_isbn(MetadataProvider::OpenLibrary, isbn, None)
                .await
                .unwrap()
                .is_empty());
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn upstream_429_is_reported_and_honoured() {
        let hits = Arc::new(AtomicUsize::new(0));
        let base = serve(
            Router::new()
                .route(
                    "/search.json",
                    get(|State(hits): State<Arc<AtomicUsize>>| async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        (
                            axum::http::StatusCode::TOO_MANY_REQUESTS,
                            [("retry-after", "120")],
                            "slow down",
                        )
                    }),
                )
                .with_state(hits.clone()),
        )
        .await;
        let client = client(base);
        for _ in 0..2 {
            let error = client
                .search(MetadataProvider::OpenLibrary, "dune", None)
                .await
                .unwrap_err();
            assert!(matches!(
                error.kind,
                MetadataErrorKind::RateLimited { retry_after } if retry_after > Duration::from_secs(100)
            ));
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn search_errors_never_echo_the_query_url() {
        let client = client("http://127.0.0.1:9".into());
        let error = client
            .search(MetadataProvider::OpenLibrary, "secret title", None)
            .await
            .unwrap_err();
        assert_eq!(error.kind, MetadataErrorKind::Upstream);
        assert!(!error.message.contains("secret"), "{}", error.message);
    }
}
