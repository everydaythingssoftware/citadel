//! Book-metadata lookups for signed-in users. Providers, their limits and
//! their DTOs live in `citadel-metadata` (ADR 0010); this module adds the
//! per-user rate limit and a short search cache, so many browsers behind one
//! server stay polite to the providers.
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    extract::{rejection::QueryRejection, Extension, Path, Query, State},
    http::{header, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use citadel_core::error::{LibraryError, LibraryErrorCode};
use citadel_metadata::{
    BookMetadata, MetadataClient, MetadataError, MetadataErrorKind, MetadataProvider,
    ProviderStatus,
};
use serde::{Deserialize, Serialize};

use super::{
    session::{blocking, SignedIn},
    ApiFailure, ApiState,
};
use citadel_core::store::CredentialSecret;

const MIB: usize = 1024 * 1024;
const MAX_TRACKED_USERS: usize = 4096;
const MAX_CONTACT_CHARS: usize = 200;

/// `api.metadata` in the server config.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct MetadataConfig {
    /// An operator contact (URL or email) added to the User-Agent providers
    /// see, as Open Library asks of heavy clients.
    pub contact: Option<String>,
    pub search: SearchConfig,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct SearchConfig {
    pub cache_bytes: usize,
    pub ttl_secs: u64,
    pub per_user_per_minute: u32,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            cache_bytes: 8 * MIB,
            ttl_secs: 10 * 60,
            per_user_per_minute: 30,
        }
    }
}

impl MetadataConfig {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if let Some(contact) = &self.contact {
            if contact.trim().is_empty()
                || contact.chars().count() > MAX_CONTACT_CHARS
                || !contact.chars().all(|c| c.is_ascii_graphic() || c == ' ')
            {
                return Err(format!(
                    "api.metadata.contact must be up to {MAX_CONTACT_CHARS} printable ASCII \
                     characters, such as \"https://books.example.com\" or \"admin@example.com\""
                ));
            }
        }
        if self.search.per_user_per_minute == 0 {
            return Err("api.metadata.search.perUserPerMinute must be at least 1".into());
        }
        if self.search.ttl_secs > 24 * 60 * 60 {
            return Err("api.metadata.search.ttlSecs must be at most 86400 (one day)".into());
        }
        Ok(())
    }
}

/// The server's metadata client and the per-user state in front of it.
pub struct Metadata {
    client: MetadataClient,
    config: MetadataConfig,
    cache: Mutex<SearchCache>,
    users: Mutex<HashMap<String, UserBucket>>,
}

impl Metadata {
    pub fn new(config: MetadataConfig) -> Result<Self, String> {
        let client = MetadataClient::new(citadel_metadata::ClientOptions {
            version: env!("CARGO_PKG_VERSION").into(),
            contact: config.contact.clone(),
        })
        .map_err(|error| error.message)?;
        Ok(Self::with_client(config, client))
    }

    /// For tests that point the client at local stand-ins for providers.
    pub fn with_client(config: MetadataConfig, client: MetadataClient) -> Self {
        Self {
            client,
            config,
            cache: Mutex::default(),
            users: Mutex::default(),
        }
    }

    /// Each user gets a bucket of `perUserPerMinute` lookups that refills
    /// over a minute. Cached answers don't spend from it.
    fn admit_user(&self, user_id: &str, now: Instant) -> Result<(), MetadataFailure> {
        let capacity = f64::from(self.config.search.per_user_per_minute);
        let per_second = capacity / 60.0;
        let mut users = self.users.lock().map_err(|_| unavailable())?;
        if users.len() >= MAX_TRACKED_USERS && !users.contains_key(user_id) {
            users.retain(|_, bucket| bucket.level(capacity, per_second, now) < capacity);
        }
        let bucket = users.entry(user_id.to_string()).or_insert(UserBucket {
            tokens: capacity,
            at: now,
        });
        bucket.tokens = bucket.level(capacity, per_second, now);
        bucket.at = now;
        if bucket.tokens < 1.0 {
            let wait = Duration::from_secs_f64((1.0 - bucket.tokens) / per_second);
            return Err(MetadataFailure::rate_limited(wait));
        }
        bucket.tokens -= 1.0;
        Ok(())
    }

    async fn lookup(
        &self,
        state: &ApiState,
        user: &SignedIn,
        provider: MetadataProvider,
        lookup: Lookup,
    ) -> Result<Vec<BookMetadata>, MetadataFailure> {
        let credential = credential(state, user, provider).await?;
        let key = lookup.cache_key(provider, &user.0.id);
        let ttl = Duration::from_secs(self.config.search.ttl_secs);
        if let Some(books) =
            self.cache
                .lock()
                .map_err(|_| unavailable())?
                .get(&key, ttl, Instant::now())
        {
            return Ok(books);
        }
        self.admit_user(&user.0.id, Instant::now())?;
        let books = match &lookup {
            Lookup::Search(query) => {
                self.client
                    .search(provider, query, credential.as_deref())
                    .await
            }
            Lookup::Isbn(isbn) => {
                self.client
                    .by_isbn(provider, isbn, credential.as_deref())
                    .await
            }
        }
        .map_err(MetadataFailure::from)?;
        self.cache.lock().map_err(|_| unavailable())?.insert(
            key,
            books.clone(),
            self.config.search.cache_bytes,
            Instant::now(),
        );
        Ok(books)
    }

    /// Check a key with the provider before it is saved; returns the
    /// provider account's name when it reports one.
    pub(super) async fn verify(
        &self,
        user: &SignedIn,
        provider: MetadataProvider,
        secret: &str,
    ) -> Result<Option<String>, MetadataFailure> {
        self.admit_user(&user.0.id, Instant::now())?;
        self.client
            .test(provider, Some(secret))
            .await
            .map_err(|error| match error.kind {
                MetadataErrorKind::Unauthorized => MetadataFailure(
                    LibraryError::invalid(format!(
                        "{} didn't accept that API key",
                        provider.display_name()
                    )),
                    None,
                ),
                _ => error.into(),
            })
    }
}

/// The user's own sealed key for a keyed provider, opened for this request.
async fn credential(
    state: &ApiState,
    user: &SignedIn,
    provider: MetadataProvider,
) -> Result<Option<String>, MetadataFailure> {
    if !provider.requires_key() {
        return Ok(None);
    }
    let name = provider.display_name();
    let user_id = user.0.id.clone();
    let vault = state.secrets.clone();
    let secret = blocking(state, move |accounts| {
        accounts.provider_credential_secret(&vault, &user_id, provider.id())
    })
    .await?;
    match secret {
        Some(CredentialSecret::Available(secret)) => Ok(Some(secret)),
        Some(CredentialSecret::NeedsReentry) => Err(LibraryError::invalid(format!(
            "Your {name} API key needs to be entered again in Account settings"
        ))
        .into()),
        None => Err(LibraryError::invalid(format!(
            "Add your {name} API key in Account settings to search {name}"
        ))
        .into()),
    }
}

struct UserBucket {
    tokens: f64,
    at: Instant,
}

impl UserBucket {
    fn level(&self, capacity: f64, per_second: f64, now: Instant) -> f64 {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        (self.tokens + elapsed * per_second).min(capacity)
    }
}

enum Lookup {
    Search(String),
    Isbn(String),
}

impl Lookup {
    /// Keyed providers' answers are cached per user: a user's own key must
    /// never answer someone else's search.
    fn cache_key(&self, provider: MetadataProvider, user_id: &str) -> String {
        let owner = if provider.requires_key() { user_id } else { "" };
        let (kind, value) = match self {
            Self::Search(query) => (
                "search",
                query
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase(),
            ),
            Self::Isbn(isbn) => (
                "isbn",
                citadel_metadata::model::canonical_isbn13(isbn).unwrap_or_else(|| isbn.clone()),
            ),
        };
        format!("{}\0{kind}\0{owner}\0{value}", provider.id())
    }
}

/// Recent answers, bounded by an approximate byte budget; the oldest go
/// first.
#[derive(Default)]
struct SearchCache {
    entries: HashMap<String, CachedSearch>,
    order: VecDeque<String>,
    bytes: usize,
}

struct CachedSearch {
    books: Vec<BookMetadata>,
    bytes: usize,
    at: Instant,
}

impl SearchCache {
    fn get(&mut self, key: &str, ttl: Duration, now: Instant) -> Option<Vec<BookMetadata>> {
        let entry = self.entries.get(key)?;
        if now.saturating_duration_since(entry.at) < ttl {
            return Some(entry.books.clone());
        }
        self.remove(key);
        None
    }

    fn insert(&mut self, key: String, books: Vec<BookMetadata>, budget: usize, now: Instant) {
        self.remove(&key);
        let bytes = key.len() + serde_json::to_vec(&books).map_or(0, |json| json.len());
        if bytes > budget / 4 {
            return;
        }
        while self.bytes + bytes > budget {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(evicted) = self.entries.remove(&oldest) {
                self.bytes -= evicted.bytes;
            }
        }
        self.bytes += bytes;
        self.order.push_back(key.clone());
        self.entries.insert(
            key,
            CachedSearch {
                books,
                bytes,
                at: now,
            },
        );
    }

    fn remove(&mut self, key: &str) {
        if let Some(entry) = self.entries.remove(key) {
            self.bytes -= entry.bytes;
            self.order.retain(|queued| queued != key);
        }
    }
}

/// A `LibraryError` plus how long to wait, sent as `Retry-After`.
pub(super) struct MetadataFailure(LibraryError, Option<Duration>);

impl MetadataFailure {
    fn rate_limited(wait: Duration) -> Self {
        Self(
            LibraryError::new(
                LibraryErrorCode::RateLimited,
                format!(
                    "Too many metadata lookups — try again in {}s.",
                    wait.as_secs().max(1)
                ),
            ),
            Some(wait),
        )
    }
}

fn unavailable() -> MetadataFailure {
    MetadataFailure(LibraryError::unavailable(), None)
}

impl From<MetadataError> for MetadataFailure {
    fn from(error: MetadataError) -> Self {
        // A rejected provider key is the user's to fix, not a signed-out
        // session, so it is never a 401.
        let (code, wait) = match error.kind {
            MetadataErrorKind::InvalidArgument | MetadataErrorKind::Unauthorized => {
                (LibraryErrorCode::InvalidArgument, None)
            }
            MetadataErrorKind::RateLimited { retry_after } => {
                (LibraryErrorCode::RateLimited, Some(retry_after))
            }
            MetadataErrorKind::Unavailable { retry_after } => {
                (LibraryErrorCode::Unavailable, Some(retry_after))
            }
            MetadataErrorKind::Upstream => (LibraryErrorCode::Unavailable, None),
        };
        Self(LibraryError::new(code, error.message), wait)
    }
}

impl From<LibraryError> for MetadataFailure {
    fn from(error: LibraryError) -> Self {
        Self(error, None)
    }
}

impl From<ApiFailure> for MetadataFailure {
    fn from(failure: ApiFailure) -> Self {
        Self(failure.0, None)
    }
}

impl IntoResponse for MetadataFailure {
    fn into_response(self) -> Response {
        let mut response = ApiFailure(self.0).into_response();
        if let Some(wait) = self.1 {
            let seconds = wait.as_secs_f64().ceil().max(1.0) as u64;
            response.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from_str(&seconds.to_string()).expect("digits are a header value"),
            );
        }
        response
    }
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct MetadataProviderInfo {
    provider: MetadataProvider,
    display_name: String,
    requires_key: bool,
    /// Whether this user can look books up with the provider right now.
    available: bool,
    /// Why not, when it isn't.
    #[schema(required = true)]
    unavailable_reason: Option<String>,
}

#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub(super) struct SearchParams {
    /// Provider ID, such as `openlibrary` or `loc`.
    #[param(value_type = MetadataProvider)]
    provider: MetadataProvider,
    /// Title, author or keywords.
    q: String,
}

#[derive(Deserialize, utoipa::IntoParams)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub(super) struct ProviderParams {
    /// Provider ID, such as `openlibrary` or `loc`.
    #[param(value_type = MetadataProvider)]
    provider: MetadataProvider,
}

fn invalid_query(_: QueryRejection) -> MetadataFailure {
    LibraryError::invalid("Invalid metadata query: provider must be a known provider ID").into()
}

#[utoipa::path(get, path = "/api/metadata/providers", operation_id = "listMetadataProviders",
    description = "Metadata providers and whether the signed-in user can use each. Keyless providers are always available.",
    responses((status = 200, body = Vec<MetadataProviderInfo>), (status = 401, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn providers(
    State(state): State<ApiState>,
    Extension(user): Extension<SignedIn>,
) -> Json<Vec<MetadataProviderInfo>> {
    let mut providers = Vec::new();
    for provider in MetadataProvider::ALL {
        let available = credential(&state, &user, provider).await;
        providers.push(MetadataProviderInfo {
            provider,
            display_name: provider.display_name().into(),
            requires_key: provider.requires_key(),
            available: available.is_ok(),
            unavailable_reason: available.err().map(|failure| failure.0.message),
        });
    }
    Json(providers)
}

#[utoipa::path(get, path = "/api/metadata/search", operation_id = "searchMetadata",
    params(SearchParams),
    description = "Free-text search one provider. No results is an empty list, not an error. Answers are cached briefly; uncached lookups count against a per-user rate limit.",
    responses((status = 200, body = Vec<BookMetadata>), (status = 400, body = LibraryError),
        (status = 401, body = LibraryError), (status = 429, body = LibraryError), (status = 503, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn search(
    State(state): State<ApiState>,
    Extension(user): Extension<SignedIn>,
    params: Result<Query<SearchParams>, QueryRejection>,
) -> Result<Json<Vec<BookMetadata>>, MetadataFailure> {
    let Query(params) = params.map_err(invalid_query)?;
    let query = params.q.trim();
    if query.is_empty() {
        return Ok(Json(Vec::new()));
    }
    if query.chars().count() > 300 {
        return Err(
            LibraryError::invalid("Metadata searches are limited to 300 characters").into(),
        );
    }
    Ok(Json(
        state
            .metadata
            .lookup(
                &state,
                &user,
                params.provider,
                Lookup::Search(query.to_string()),
            )
            .await?,
    ))
}

#[utoipa::path(get, path = "/api/metadata/isbn/{isbn}", operation_id = "lookUpMetadataByIsbn",
    params(("isbn" = String, Path, description = "ISBN-10 or ISBN-13, hyphens allowed"), ProviderParams),
    description = "Look one provider up by ISBN. No match is an empty list, not an error.",
    responses((status = 200, body = Vec<BookMetadata>), (status = 400, body = LibraryError),
        (status = 401, body = LibraryError), (status = 429, body = LibraryError), (status = 503, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn by_isbn(
    State(state): State<ApiState>,
    Extension(user): Extension<SignedIn>,
    Path(isbn): Path<String>,
    params: Result<Query<ProviderParams>, QueryRejection>,
) -> Result<Json<Vec<BookMetadata>>, MetadataFailure> {
    let Query(params) = params.map_err(invalid_query)?;
    let isbn = citadel_metadata::model::normalize_isbn(&isbn)
        .ok_or_else(|| LibraryError::invalid("Not a valid ISBN"))?;
    Ok(Json(
        state
            .metadata
            .lookup(&state, &user, params.provider, Lookup::Isbn(isbn))
            .await?,
    ))
}

#[utoipa::path(post, path = "/api/metadata/providers/{provider}/test", operation_id = "testMetadataProvider",
    params(("provider" = MetadataProvider, Path, description = "Provider ID")),
    description = "Check that the server can reach a provider, with the user's own key when it needs one.",
    responses((status = 200, body = ProviderStatus), (status = 400, body = LibraryError),
        (status = 401, body = LibraryError), (status = 429, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn test(
    State(state): State<ApiState>,
    Extension(user): Extension<SignedIn>,
    Path(provider): Path<MetadataProvider>,
) -> Result<Json<ProviderStatus>, MetadataFailure> {
    let metadata = &state.metadata;
    let credential = credential(&state, &user, provider).await?;
    metadata.admit_user(&user.0.id, Instant::now())?;
    let result = metadata.client.test(provider, credential.as_deref()).await;
    if result.is_ok() && credential.is_some() {
        let user_id = user.0.id.clone();
        blocking(&state, move |accounts| {
            accounts.mark_provider_credential_verified(&user_id, provider.id())
        })
        .await?;
    }
    Ok(Json(match result {
        Ok(_) => ProviderStatus {
            provider,
            is_valid: true,
            message: "Connection successful".into(),
        },
        Err(error) => ProviderStatus {
            provider,
            is_valid: false,
            message: error.message,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book(title: &str) -> BookMetadata {
        serde_json::from_value(serde_json::json!({
            "provider": "openlibrary", "provider_id": "OL1M", "identifier_label": "openlibrary",
            "title": title, "subtitle": null, "authors": [], "isbn": null, "release_year": null,
            "description": null, "image_url": null, "publisher": null, "subjects": [],
            "genre_candidates": [], "language_code": null, "slug": null
        }))
        .unwrap()
    }

    #[test]
    fn config_defaults_and_validation() {
        let config: MetadataConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(config.search.per_user_per_minute, 30);
        assert!(config.validate().is_ok());
        for invalid in [
            serde_json::json!({"contact": "admin\n@example.com"}),
            serde_json::json!({"contact": "  "}),
            serde_json::json!({"search": {"perUserPerMinute": 0}}),
            serde_json::json!({"search": {"ttlSecs": 90000}}),
        ] {
            let config: MetadataConfig = serde_json::from_value(invalid.clone()).unwrap();
            assert!(config.validate().is_err(), "{invalid}");
        }
        assert!(serde_json::from_value::<MetadataConfig>(serde_json::json!({"cache": 1})).is_err());
    }

    #[test]
    fn keyed_answers_are_cached_per_user_and_queries_are_normalized() {
        let search = |query: &str| Lookup::Search(query.into());
        assert_eq!(
            search(" Dune  Herbert").cache_key(MetadataProvider::OpenLibrary, "a"),
            search("dune herbert").cache_key(MetadataProvider::OpenLibrary, "b"),
        );
        assert_ne!(
            search("dune").cache_key(MetadataProvider::Hardcover, "a"),
            search("dune").cache_key(MetadataProvider::Hardcover, "b"),
        );
        assert_eq!(
            Lookup::Isbn("0553103547".into()).cache_key(MetadataProvider::Loc, "a"),
            Lookup::Isbn("9780553103540".into()).cache_key(MetadataProvider::Loc, "a"),
        );
    }

    #[test]
    fn cache_expires_and_evicts_oldest_within_budget() {
        let now = Instant::now();
        let ttl = Duration::from_secs(60);
        let size = 1 + serde_json::to_vec(&vec![book("A")]).unwrap().len();
        let budget = size * 4;
        let mut cache = SearchCache::default();
        for key in ["a", "b", "c", "d", "e"] {
            cache.insert(key.into(), vec![book("A")], budget, now);
        }
        assert!(cache.bytes <= budget);
        assert!(cache.get("a", ttl, now).is_none(), "oldest evicted");
        assert!(cache.get("e", ttl, now).is_some());
        assert!(cache.get("e", ttl, now + ttl).is_none(), "expired");
        assert!(!cache.entries.contains_key("e"));
        cache.insert("big".into(), vec![book("A"); 2], budget, now);
        assert!(!cache.entries.contains_key("big"), "too large to cache");
    }

    #[test]
    fn users_are_limited_independently() {
        let metadata = Metadata::new(MetadataConfig {
            search: SearchConfig {
                per_user_per_minute: 2,
                ..SearchConfig::default()
            },
            ..MetadataConfig::default()
        })
        .unwrap();
        let now = Instant::now();
        metadata.admit_user("a", now).ok().unwrap();
        metadata.admit_user("a", now).ok().unwrap();
        let refused = metadata.admit_user("a", now).err().unwrap();
        assert_eq!(refused.0.code, LibraryErrorCode::RateLimited);
        assert_eq!(refused.1, Some(Duration::from_secs(30)));
        metadata.admit_user("b", now).ok().unwrap();
        metadata
            .admit_user("a", now + Duration::from_secs(30))
            .ok()
            .unwrap();
    }
}
