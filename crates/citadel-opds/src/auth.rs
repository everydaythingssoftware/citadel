use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use axum::{
    extract::{Request, State},
    http::{
        header::{AUTHORIZATION, RETRY_AFTER, WWW_AUTHENTICATE},
        HeaderValue, StatusCode,
    },
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use sha2::Sha256;
use subtle::ConstantTimeEq;

const DEFAULT_CACHE_CAPACITY: usize = 256;
const DEFAULT_CACHE_TTL: Duration = Duration::from_secs(30);
const DEFAULT_TARGET_DURATION: Duration = Duration::from_millis(250);
/// Caps parallel Argon2 verifications. Hashing is tuned to be expensive;
/// unbounded parallelism lets one client make every request slow.
const ARGON2_CONCURRENCY: usize = 3;
const BASIC_CHALLENGE: &str = "Basic realm=\"Citadel\", charset=\"UTF-8\"";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OpdsAuthCredentials {
    pub username: String,
    pub verifier: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpdsAuthError {
    InvalidVerifier,
    PasswordHashingFailed,
}

impl std::fmt::Display for OpdsAuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidVerifier => {
                formatter.write_str("The OPDS credential verifier is invalid.")
            }
            Self::PasswordHashingFailed => {
                formatter.write_str("Could not create OPDS credentials.")
            }
        }
    }
}

impl std::error::Error for OpdsAuthError {}

/// Creates credentials which store only a username and an Argon2id PHC verifier.
pub(crate) fn create_credentials(
    username: String,
    password: &[u8],
) -> Result<OpdsAuthCredentials, OpdsAuthError> {
    let salt = SaltString::generate(&mut OsRng);
    let verifier = argon2id()
        .hash_password(password, &salt)
        .map_err(|_| OpdsAuthError::PasswordHashingFailed)?
        .to_string();

    Ok(OpdsAuthCredentials { username, verifier })
}

#[derive(Clone)]
pub struct OpdsBasicAuth {
    enabled: Option<Arc<EnabledAuth>>,
}

struct EnabledAuth {
    credentials: OpdsAuthCredentials,
    cache_key: [u8; 32],
    cache: Mutex<AuthCache>,
    target_duration: Mutex<Duration>,
    /// Caps concurrent Argon2 verifications; hashing is deliberately expensive
    /// and unbounded parallelism would make every request slow.
    permits: Arc<tokio::sync::Semaphore>,
    backoff: Mutex<Backoff>,
}

/// Global exponential backoff on consecutive rejected attempts. With a
/// ~30.5-bit generated password, throttling the online attacker to ~1 guess
/// per second is what turns the margin into years.
#[derive(Default)]
struct Backoff {
    consecutive_failures: u32,
    until: Option<Instant>,
}

const BACKOFF_START_THRESHOLD: u32 = 3;
const BACKOFF_BASE: Duration = Duration::from_secs(2);
const BACKOFF_CAP: Duration = Duration::from_secs(60);

impl Backoff {
    /// Some(_) while the attacker is being refused without a hash.
    fn refused_until(&self, now: Instant) -> Option<Duration> {
        self.until
            .filter(|until| *until > now)
            .map(|until| until.duration_since(now))
    }

    fn note_rejection(&mut self, now: Instant) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if self.consecutive_failures >= BACKOFF_START_THRESHOLD {
            let shift = self
                .consecutive_failures
                .saturating_sub(BACKOFF_START_THRESHOLD)
                .min(5) as u32;
            self.until = Some(now + BACKOFF_BASE.saturating_mul(1 << shift).min(BACKOFF_CAP));
        }
    }

    fn note_success(&mut self) {
        *self = Backoff::default();
    }
}

#[derive(Clone, Copy)]
enum CachedOutcome {
    Authorized,
    Rejected,
}

struct CacheEntry {
    tag: [u8; 32],
    outcome: CachedOutcome,
    target_duration: Duration,
    expires_at: Instant,
}

struct AuthCache {
    entries: Vec<CacheEntry>,
    capacity: usize,
    ttl: Duration,
}

impl AuthCache {
    fn new(capacity: usize, ttl: Duration) -> Self {
        Self {
            entries: Vec::with_capacity(capacity),
            capacity,
            ttl,
        }
    }

    fn get(&mut self, tag: &[u8; 32]) -> Option<(CachedOutcome, Duration)> {
        let now = Instant::now();
        self.entries.retain(|entry| entry.expires_at > now);
        self.entries
            .iter()
            .find(|entry| bool::from(entry.tag.ct_eq(tag)))
            .map(|entry| (entry.outcome, entry.target_duration))
    }

    fn insert(&mut self, tag: [u8; 32], outcome: CachedOutcome, target_duration: Duration) {
        if self.capacity == 0 {
            return;
        }
        if self.entries.len() == self.capacity {
            self.entries.remove(0);
        }
        self.entries.push(CacheEntry {
            tag,
            outcome,
            target_duration,
            expires_at: Instant::now() + self.ttl,
        });
    }
}

impl OpdsBasicAuth {
    pub fn disabled() -> Self {
        Self { enabled: None }
    }

    pub(crate) fn enabled(credentials: OpdsAuthCredentials) -> Result<Self, OpdsAuthError> {
        Self::enabled_with_settings(
            credentials,
            DEFAULT_CACHE_CAPACITY,
            DEFAULT_CACHE_TTL,
            DEFAULT_TARGET_DURATION,
        )
    }

    fn enabled_with_settings(
        credentials: OpdsAuthCredentials,
        cache_capacity: usize,
        cache_ttl: Duration,
        target_duration: Duration,
    ) -> Result<Self, OpdsAuthError> {
        let password_hash =
            PasswordHash::new(&credentials.verifier).map_err(|_| OpdsAuthError::InvalidVerifier)?;
        if password_hash.algorithm.as_str() != "argon2id" {
            return Err(OpdsAuthError::InvalidVerifier);
        }

        let mut cache_key = [0; 32];
        OsRng.fill_bytes(&mut cache_key);
        Ok(Self {
            enabled: Some(Arc::new(EnabledAuth {
                credentials,
                cache_key,
                cache: Mutex::new(AuthCache::new(cache_capacity, cache_ttl)),
                target_duration: Mutex::new(target_duration),
                permits: Arc::new(tokio::sync::Semaphore::new(ARGON2_CONCURRENCY)),
                backoff: Mutex::new(Backoff::default()),
            })),
        })
    }

    fn is_enabled(&self) -> bool {
        self.enabled.is_some()
    }

    /// Authorizes complete Authorization header bytes. Disabled authentication does not parse them.
    async fn authorize(&self, authorization: Option<&[u8]>) -> AuthOutcome {
        let Some(enabled) = &self.enabled else {
            return AuthOutcome::Authorized;
        };

        {
            let backoff = enabled.backoff.lock().unwrap();
            if backoff.refused_until(Instant::now()).is_some() {
                return AuthOutcome::Backoff;
            }
        }

        let started_at = Instant::now();
        let authorization = authorization.unwrap_or_default();
        let tag = opaque_tag(&enabled.cache_key, authorization);
        if let Some((outcome, cached_duration)) = enabled
            .cache
            .lock()
            .ok()
            .and_then(|mut cache| cache.get(&tag))
        {
            let target_duration = current_target_duration(enabled).max(cached_duration);
            {
                let mut backoff = enabled.backoff.lock().unwrap();
                match outcome {
                    CachedOutcome::Authorized => backoff.note_success(),
                    CachedOutcome::Rejected => backoff.note_rejection(Instant::now()),
                }
            }
            pad_to_target(started_at, target_duration).await;
            return match outcome {
                CachedOutcome::Authorized => AuthOutcome::Authorized,
                CachedOutcome::Rejected => AuthOutcome::Rejected,
            };
        }

        // Cap parallel Argon2 work: hashing is deliberately expensive, and
        // unbounded parallelism lets one client make every request slow.
        let permit = match enabled.permits.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => return AuthOutcome::Busy,
        };
        let parsed = parse_basic_credentials(authorization);
        let authorized = match parsed {
            Some(credentials) if credentials.username == enabled.credentials.username => {
                let verifier = enabled.credentials.verifier.clone();
                tokio::task::spawn_blocking(move || {
                    verify_password(&verifier, &credentials.password)
                })
                .await
                .unwrap_or(false)
            }
            _ => false,
        };
        drop(permit);
        let target_duration = target_duration(enabled, started_at.elapsed());
        let outcome = if authorized {
            CachedOutcome::Authorized
        } else {
            CachedOutcome::Rejected
        };
        if let Ok(mut cache) = enabled.cache.lock() {
            cache.insert(tag, outcome, target_duration);
        }
        {
            let mut backoff = enabled.backoff.lock().unwrap();
            match outcome {
                CachedOutcome::Authorized => backoff.note_success(),
                CachedOutcome::Rejected => backoff.note_rejection(Instant::now()),
            }
        }
        pad_to_target(started_at, target_duration).await;
        match outcome {
            CachedOutcome::Authorized => AuthOutcome::Authorized,
            CachedOutcome::Rejected => AuthOutcome::Rejected,
        }
    }
}

enum AuthOutcome {
    Authorized,
    Rejected,
    Busy,
    Backoff,
}

/// Axum 0.8 middleware. Apply it as the final layer around the OPDS router.
pub(crate) async fn require_basic_auth(
    State(auth): State<OpdsBasicAuth>,
    request: Request,
    next: Next,
) -> Response {
    if !auth.is_enabled() {
        return next.run(request).await;
    }

    let authorization = request
        .headers()
        .get(AUTHORIZATION)
        .map(|value| value.as_bytes().to_vec());
    match auth.authorize(authorization.as_deref()).await {
        AuthOutcome::Authorized => next.run(request).await,
        AuthOutcome::Backoff => (
            StatusCode::TOO_MANY_REQUESTS,
            [(RETRY_AFTER, HeaderValue::from_static("1"))],
        )
            .into_response(),
        AuthOutcome::Busy => (
            StatusCode::SERVICE_UNAVAILABLE,
            [
                (RETRY_AFTER, HeaderValue::from_static("1")),
                (WWW_AUTHENTICATE, HeaderValue::from_static(BASIC_CHALLENGE)),
            ],
        )
            .into_response(),
        AuthOutcome::Rejected => unauthorized_response(),
    }
}

fn current_target_duration(enabled: &EnabledAuth) -> Duration {
    enabled
        .target_duration
        .lock()
        .map(|duration| *duration)
        .unwrap_or(DEFAULT_TARGET_DURATION)
}

struct BasicCredentials {
    username: String,
    password: Vec<u8>,
}

fn parse_basic_credentials(authorization: &[u8]) -> Option<BasicCredentials> {
    let authorization = std::str::from_utf8(authorization).ok()?;
    let (scheme, encoded) = authorization.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") || encoded.is_empty() || encoded.contains(' ') {
        return None;
    }
    let decoded = STANDARD.decode(encoded).ok()?;
    let separator = decoded.iter().position(|byte| *byte == b':')?;
    let username = std::str::from_utf8(&decoded[..separator]).ok()?.to_string();
    Some(BasicCredentials {
        username,
        password: decoded[separator + 1..].to_vec(),
    })
}

fn verify_password(verifier: &str, password: &[u8]) -> bool {
    let Ok(password_hash) = PasswordHash::new(verifier) else {
        return false;
    };
    password_hash.algorithm.as_str() == "argon2id"
        && argon2id().verify_password(password, &password_hash).is_ok()
}

fn argon2id() -> Argon2<'static> {
    Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::default())
}

fn opaque_tag(cache_key: &[u8; 32], authorization: &[u8]) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(cache_key).expect("HMAC accepts a fixed-size key");
    mac.update(authorization);
    mac.finalize().into_bytes().into()
}

fn target_duration(enabled: &EnabledAuth, elapsed: Duration) -> Duration {
    let Ok(mut target_duration) = enabled.target_duration.lock() else {
        return elapsed.max(DEFAULT_TARGET_DURATION);
    };
    *target_duration = (*target_duration).max(elapsed);
    *target_duration
}

async fn pad_to_target(started_at: Instant, target_duration: Duration) {
    if let Some(remaining) = target_duration.checked_sub(started_at.elapsed()) {
        tokio::time::sleep(remaining).await;
    }
}

fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(WWW_AUTHENTICATE, HeaderValue::from_static(BASIC_CHALLENGE))],
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{header::AUTHORIZATION, Request},
        middleware,
        routing::get,
        Router,
    };
    use tower::ServiceExt;

    use super::*;

    fn basic_header(username: &str, password: &[u8]) -> Vec<u8> {
        let mut credentials = username.as_bytes().to_vec();
        credentials.push(b':');
        credentials.extend(password);
        format!("Basic {}", STANDARD.encode(credentials)).into_bytes()
    }

    fn enabled_auth(username: &str, password: &[u8], target_duration: Duration) -> OpdsBasicAuth {
        OpdsBasicAuth::enabled_with_settings(
            create_credentials(username.to_string(), password).unwrap(),
            2,
            Duration::from_secs(1),
            target_duration,
        )
        .unwrap()
    }

    fn app(auth: OpdsBasicAuth) -> Router {
        Router::new()
            .route("/opds", get(|| async { "catalog" }))
            .layer(middleware::from_fn_with_state(auth, require_basic_auth))
    }

    async fn response(auth: OpdsBasicAuth, authorization: Option<Vec<u8>>) -> Response {
        let mut request = Request::builder().uri("/opds");
        if let Some(authorization) = authorization {
            request = request.header(AUTHORIZATION, authorization);
        }
        app(auth)
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[test]
    fn credentials_store_a_random_argon2id_phc_verifier() {
        let first = create_credentials("reader".to_string(), b"correct horse").unwrap();
        let second = create_credentials("reader".to_string(), b"correct horse").unwrap();

        assert_eq!(first.username, "reader");
        assert!(first.verifier.starts_with("$argon2id$"));
        assert_ne!(first.verifier, second.verifier);
        let password_hash = PasswordHash::new(&first.verifier).unwrap();
        assert!(argon2id()
            .verify_password(b"correct horse", &password_hash)
            .is_ok());
    }

    #[tokio::test]
    async fn repeated_failures_throttle_into_a_backoff_window() {
        let auth = enabled_auth("reader", b"correct horse", Duration::ZERO);
        let wrong = Some(&basic_header("reader", b"wrong password")[..]);

        for _ in 0..BACKOFF_START_THRESHOLD {
            assert!(matches!(auth.authorize(wrong).await, AuthOutcome::Rejected));
        }
        // Next attempt is refused without a verification pass.
        assert!(matches!(auth.authorize(wrong).await, AuthOutcome::Backoff));

        // Backoff expires and verification resumes.
        tokio::time::sleep(BACKOFF_BASE).await;
        assert!(matches!(auth.authorize(wrong).await, AuthOutcome::Rejected));
    }

    #[tokio::test]
    async fn successful_authentication_resets_the_backoff_budget() {
        let auth = enabled_auth("reader", b"correct horse", Duration::ZERO);
        let right = Some(&basic_header("reader", b"correct horse")[..]);
        let wrong = Some(&basic_header("reader", b"wrong password")[..]);

        for _ in 0..BACKOFF_START_THRESHOLD.saturating_sub(1) {
            assert!(matches!(auth.authorize(wrong).await, AuthOutcome::Rejected));
        }
        assert!(matches!(
            auth.authorize(right).await,
            AuthOutcome::Authorized
        ));
        // The failure streak was reset: more failures are answered (slowly),
        // not refused.
        assert!(matches!(auth.authorize(wrong).await, AuthOutcome::Rejected));
    }

    #[tokio::test]
    async fn disabled_auth_bypasses_even_malformed_authorization() {
        let auth = OpdsBasicAuth::disabled();

        assert!(matches!(
            auth.authorize(Some(b"not even close to Basic")).await,
            AuthOutcome::Authorized
        ));
        assert_eq!(
            response(auth, Some(b"not even close to Basic".to_vec()))
                .await
                .status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn enabled_auth_accepts_only_the_configured_basic_credentials() {
        let auth = enabled_auth("reader", b"correct horse", Duration::ZERO);

        assert!(matches!(
            auth.authorize(Some(&basic_header("reader", b"correct horse")))
                .await,
            AuthOutcome::Authorized
        ));
        assert!(matches!(
            auth.authorize(Some(&basic_header("reader", b"wrong password")))
                .await,
            AuthOutcome::Rejected
        ));
        assert!(matches!(
            auth.authorize(Some(&basic_header("someone-else", b"correct horse")))
                .await,
            AuthOutcome::Rejected
        ));
        assert!(matches!(auth.authorize(None).await, AuthOutcome::Rejected));
    }

    #[tokio::test]
    async fn middleware_challenges_missing_and_wrong_credentials_and_allows_correct_ones() {
        let auth = enabled_auth("reader", b"correct horse", Duration::ZERO);

        let missing = response(auth.clone(), None).await;
        let wrong = response(
            auth.clone(),
            Some(basic_header("reader", b"wrong password")),
        )
        .await;
        let correct = response(auth, Some(basic_header("reader", b"correct horse"))).await;

        for rejected in [missing, wrong] {
            assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(
                rejected.headers().get(WWW_AUTHENTICATE).unwrap(),
                BASIC_CHALLENGE
            );
        }
        assert_eq!(correct.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn cache_records_and_reuses_the_authorization_outcome_without_raw_header_bytes() {
        let auth = enabled_auth("reader", b"correct horse", Duration::ZERO);
        let header = basic_header("reader", b"correct horse");

        assert!(matches!(
            auth.authorize(Some(&header)).await,
            AuthOutcome::Authorized
        ));
        let enabled = auth.enabled.as_ref().unwrap();
        let cache = enabled.cache.lock().unwrap();
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(
            cache.entries[0].tag,
            opaque_tag(&enabled.cache_key, &header)
        );
        assert!(matches!(
            cache.entries[0].outcome,
            CachedOutcome::Authorized
        ));
        drop(cache);

        assert!(matches!(
            auth.authorize(Some(&header)).await,
            AuthOutcome::Authorized
        ));
        assert_eq!(enabled.cache.lock().unwrap().entries.len(), 1);
    }

    #[tokio::test]
    async fn unknown_usernames_and_cached_rejections_are_padded_to_the_target_duration() {
        let target_duration = Duration::from_millis(20);
        let auth = enabled_auth("reader", b"correct horse", target_duration);
        let unknown_header = basic_header("unknown", b"correct horse");

        let first_started_at = Instant::now();
        assert!(matches!(
            auth.authorize(Some(&unknown_header)).await,
            AuthOutcome::Rejected
        ));
        let first_elapsed = first_started_at.elapsed();

        let cached_started_at = Instant::now();
        assert!(matches!(
            auth.authorize(Some(&unknown_header)).await,
            AuthOutcome::Rejected
        ));
        let cached_elapsed = cached_started_at.elapsed();

        let minimum_padded_duration = target_duration - Duration::from_millis(2);
        assert!(first_elapsed >= minimum_padded_duration);
        assert!(cached_elapsed >= minimum_padded_duration);
    }

    #[test]
    fn basic_parser_preserves_password_bytes_after_the_first_colon() {
        let header = basic_header("reader", b"pa:ss:word");
        let credentials = parse_basic_credentials(&header).unwrap();

        assert_eq!(credentials.username, "reader");
        assert_eq!(credentials.password, b"pa:ss:word");
    }

    #[test]
    fn cache_uses_only_opaque_complete_header_tags_and_is_bounded() {
        let key = [7; 32];
        let first = opaque_tag(&key, b"Basic cmVhZGVyOmZpcnN0");
        let second = opaque_tag(&key, b"Basic cmVhZGVyOnNlY29uZA==");
        let differently_cased = opaque_tag(&key, b"basic cmVhZGVyOmZpcnN0");
        assert_ne!(first, second);
        assert_ne!(first, differently_cased);

        let mut cache = AuthCache::new(1, Duration::from_secs(1));
        cache.insert(first, CachedOutcome::Authorized, Duration::from_millis(10));
        cache.insert(second, CachedOutcome::Rejected, Duration::from_millis(20));

        assert!(cache.get(&first).is_none());
        assert_eq!(
            cache
                .get(&second)
                .map(|(_, target_duration)| target_duration),
            Some(Duration::from_millis(20))
        );
    }

    #[test]
    fn unauthorized_response_uses_the_koreader_basic_challenge() {
        let response = unauthorized_response();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.headers().get(WWW_AUTHENTICATE).unwrap(),
            "Basic realm=\"Citadel\", charset=\"UTF-8\""
        );
    }
}
