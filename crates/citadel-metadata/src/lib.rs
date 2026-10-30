//! Book-metadata providers. Hardcover (GraphQL), Library of Congress, the
//! Deutsche Nationalbibliothek and K10plus (SRU/MARCXML), and Open Library
//! (JSON-REST) all return the unified [`BookMetadata`] from a single search
//! call. The desktop and the server share one [`MetadataClient`] each; see
//! `docs/adr/0010-metadata-lookup-on-the-server.md`.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

mod covers;
mod error;
mod guard;
mod http;
pub mod model;
mod providers;

pub use covers::{CoverOptions, CoverPolicy, HostRule};
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
    pub covers: CoverOptions,
}

/// Where each provider lives. Only tests point these anywhere else.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub openlibrary: String,
    pub hardcover: String,
    pub loc: String,
    pub dnb: String,
    pub k10plus: String,
    /// Which hosts each provider's cover images may come from.
    pub covers: CoverPolicy,
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
            covers: CoverPolicy::default(),
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
    covers: covers::Covers,
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
        let user_agent = user_agent(&options);
        Ok(Self {
            http: http::Http::new(&user_agent)?,
            covers: covers::Covers::new(&user_agent, endpoints.covers.clone(), options.covers)?,
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
        let mut books = self
            .guards
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
            .await?;
        self.covers.register(&mut books);
        Ok(books)
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
        let mut books = self
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
        self.covers.register(&mut books);
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

    /// Refresh the cover IDs of results a host is serving from its own
    /// cache, so they stay resolvable while shown.
    pub fn register_covers(&self, books: &mut [BookMetadata]) {
        self.covers.register(books);
    }

    /// A small JPEG of a result's cover, for showing beside the result.
    pub async fn cover_preview(&self, cover_id: &str) -> Result<Arc<Vec<u8>>, MetadataError> {
        self.covers.preview(cover_id).await
    }

    /// Start fetching a chosen cover at full size so applying it is quick.
    pub async fn prefetch_cover(&self, cover_id: &str) -> Result<(), MetadataError> {
        self.covers.prefetch(cover_id).await
    }

    /// The full-size cover as a re-encoded JPEG, ready to store on a book.
    pub async fn cover_image(&self, cover_id: &str) -> Result<Arc<Vec<u8>>, MetadataError> {
        self.covers.full(cover_id).await
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

/// Check an uploaded cover image and re-encode it as a JPEG, refusing
/// anything over `max_bytes`, unreadable, or too large to decode safely.
pub async fn reencode_cover(bytes: Vec<u8>, max_bytes: u64) -> Result<Vec<u8>, MetadataError> {
    if bytes.len() as u64 > max_bytes {
        return Err(MetadataError::new(
            MetadataErrorKind::TooLarge,
            format!(
                "Cover images are limited to {} MiB.",
                max_bytes / (1024 * 1024)
            ),
        ));
    }
    covers::reencode(bytes, None).await
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
                ..ClientOptions::default()
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
            ..ClientOptions::default()
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

    fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbImage::from_pixel(width, height, image::Rgb([20, 90, 160]));
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut bytes)
            .encode_image(&image)
            .unwrap();
        bytes
    }

    /// A Hardcover stand-in whose results point at images on the same
    /// loopback server, one per refusal case.
    async fn cover_server() -> (String, Arc<AtomicUsize>) {
        use axum::{http::header, response::IntoResponse, routing::post};
        let image_hits = Arc::new(AtomicUsize::new(0));
        let base = Arc::new(Mutex::new(String::new()));
        let router = Router::new()
            .route(
                "/graphql",
                post({
                    let base = base.clone();
                    move || {
                        let base = base.lock().unwrap().clone();
                        async move {
                            let hits: Vec<_> = ["ok", "big", "html", "slow", "offsite", "hop"]
                                .iter()
                                .enumerate()
                                .map(|(id, name)| serde_json::json!({"document": {
                                    "id": id, "title": name, "image": {"url": format!("{base}/img/{name}")}
                                }}))
                                .collect();
                            axum::Json(serde_json::json!({"data": {"search": {"ids": [], "results": {"hits": hits}}}}))
                        }
                    }
                }),
            )
            .route(
                "/img/{name}",
                get({
                    let base = base.clone();
                    move |axum::extract::Path(name): axum::extract::Path<String>,
                          State(hits): State<Arc<AtomicUsize>>| {
                        let base = base.lock().unwrap().clone();
                        async move {
                            hits.fetch_add(1, Ordering::SeqCst);
                            match name.as_str() {
                                "ok" | "final" => {
                                    ([(header::CONTENT_TYPE, "image/jpeg")], jpeg(900, 1350)).into_response()
                                }
                                "big" => ([(header::CONTENT_TYPE, "image/jpeg")], vec![0u8; 4096]).into_response(),
                                "html" => ([(header::CONTENT_TYPE, "text/html")], "<html>").into_response(),
                                "slow" => {
                                    tokio::time::sleep(Duration::from_secs(5)).await;
                                    "late".into_response()
                                }
                                "offsite" => (
                                    axum::http::StatusCode::FOUND,
                                    [(header::LOCATION, base.replace("127.0.0.1", "localhost") + "/img/ok")],
                                )
                                    .into_response(),
                                _ => (axum::http::StatusCode::FOUND, [(header::LOCATION, "/img/final")])
                                    .into_response(),
                            }
                        }
                    }
                }),
            )
            .with_state(image_hits.clone());
        let address = serve(router).await;
        *base.lock().unwrap() = address.clone();
        (address, image_hits)
    }

    fn cover_client(base: &str, policy: CoverPolicy) -> MetadataClient {
        MetadataClient::with_endpoints(
            ClientOptions {
                version: "test".into(),
                contact: None,
                covers: CoverOptions {
                    max_image_bytes: 1024 * 1024,
                    fetch_timeout: Duration::from_millis(500),
                    ..CoverOptions::default()
                },
            },
            Endpoints {
                hardcover: format!("{base}/graphql"),
                covers: policy,
                ..Endpoints::default()
            },
        )
        .unwrap()
    }

    fn loopback_policy() -> CoverPolicy {
        CoverPolicy {
            hosts: vec![(
                MetadataProvider::Hardcover,
                HostRule::Exact("127.0.0.1".into()),
            )],
            https_only: false,
        }
    }

    #[tokio::test]
    async fn covers_are_fetched_only_through_their_ids_and_within_limits() {
        let (base, image_hits) = cover_server().await;
        let client = cover_client(&base, loopback_policy());
        let books = client
            .search(MetadataProvider::Hardcover, "dune", Some("key"))
            .await
            .unwrap();
        let id = |title: &str| {
            books
                .iter()
                .find(|book| book.title == title)
                .and_then(|book| book.cover_id.clone())
                .unwrap()
        };
        let json = serde_json::to_string(&books).unwrap();
        assert!(
            !json.contains("127.0.0.1"),
            "URLs never reach clients: {json}"
        );

        let preview = client.cover_preview(&id("ok")).await.unwrap();
        let decoded = image::load_from_memory(&preview).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (400, 600));
        client.cover_preview(&id("ok")).await.unwrap();
        assert_eq!(image_hits.load(Ordering::SeqCst), 1, "preview cached");

        client.prefetch_cover(&id("ok")).await.unwrap();
        let full = client.cover_image(&id("ok")).await.unwrap();
        let decoded = image::load_from_memory(&full).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (900, 1350));
        assert_eq!(
            image_hits.load(Ordering::SeqCst),
            2,
            "apply uses the prefetch"
        );

        let hop = client.cover_image(&id("hop")).await.unwrap();
        assert!(
            image::load_from_memory(&hop).is_ok(),
            "same-host redirects are followed"
        );

        for (title, kind) in [
            ("big", MetadataErrorKind::InvalidArgument),
            ("html", MetadataErrorKind::Upstream),
            ("slow", MetadataErrorKind::Upstream),
            ("offsite", MetadataErrorKind::Upstream),
        ] {
            let error = client.cover_image(&id(title)).await.unwrap_err();
            assert_eq!(error.kind, kind, "{title}: {}", error.message);
        }
        assert_eq!(
            client
                .cover_image("0123456789abcdef0123456789abcdef")
                .await
                .unwrap_err()
                .kind,
            MetadataErrorKind::Gone
        );
    }

    #[tokio::test]
    async fn oversized_covers_are_refused_while_downloading() {
        let (base, _) = cover_server().await;
        let client = MetadataClient::with_endpoints(
            ClientOptions {
                version: "test".into(),
                contact: None,
                covers: CoverOptions {
                    max_image_bytes: 1024,
                    ..CoverOptions::default()
                },
            },
            Endpoints {
                hardcover: format!("{base}/graphql"),
                covers: loopback_policy(),
                ..Endpoints::default()
            },
        )
        .unwrap();
        let books = client
            .search(MetadataProvider::Hardcover, "dune", Some("key"))
            .await
            .unwrap();
        let big = books.iter().find(|book| book.title == "big").unwrap();
        let error = client
            .cover_image(big.cover_id.as_deref().unwrap())
            .await
            .unwrap_err();
        assert_eq!(error.kind, MetadataErrorKind::TooLarge);
    }

    #[tokio::test]
    async fn production_policy_never_registers_plain_http_or_unknown_hosts() {
        let (base, _) = cover_server().await;
        let client = cover_client(&base, CoverPolicy::default());
        let books = client
            .search(MetadataProvider::Hardcover, "dune", Some("key"))
            .await
            .unwrap();
        assert!(books.iter().all(|book| book.cover_id.is_none()));
    }

    #[tokio::test]
    async fn uploaded_covers_are_size_checked_and_reencoded() {
        let jpeg = reencode_cover(jpeg(10, 10), 1024 * 1024).await.unwrap();
        assert!(image::load_from_memory(&jpeg).is_ok());
        assert_eq!(
            reencode_cover(vec![0; 2048], 1024).await.unwrap_err().kind,
            MetadataErrorKind::TooLarge
        );
        assert_eq!(
            reencode_cover(b"GIF89a nope".to_vec(), 1024)
                .await
                .unwrap_err()
                .kind,
            MetadataErrorKind::InvalidArgument
        );
    }
}
