//! HTTP Basic authentication for the OPDS server.
//!
//! The credential snapshot is hot-swappable: listeners read it per request,
//! so creating, rotating or revoking device keys never interrupts a running
//! share. The snapshot holds salted hashes, never keys (ADR 0013). Consecutive
//! rejections back off exponentially, which is the online-guessing defense.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
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
use citadel_core::store::DeviceKeyVerifier;

const BASIC_CHALLENGE: &str = "Basic realm=\"Citadel\", charset=\"UTF-8\"";
/// How often a key's use is reported to the host, so busy readers (every
/// cover is a request) don't write to the host's database each time.
const KEY_USE_REPORT_INTERVAL: Duration = Duration::from_secs(60 * 60);

pub(crate) type KeyUsedHook = Arc<dyn Fn(&str) + Send + Sync>;

/// Global exponential backoff on consecutive rejected attempts. With a
/// ~30.5-bit generated password, throttling the online attacker to a couple
/// of guesses per second is what turns the margin into years.
#[derive(Default)]
struct Backoff {
    consecutive_failures: u32,
    until: Option<Instant>,
}

const BACKOFF_START_THRESHOLD: u32 = 3;
const BACKOFF_BASE: Duration = Duration::from_secs(2);
const BACKOFF_CAP: Duration = Duration::from_secs(60);

impl Backoff {
    /// Some(_) while the attacker is being refused without a check.
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
                .min(5);
            self.until = Some(now + BACKOFF_BASE.saturating_mul(1 << shift).min(BACKOFF_CAP));
        }
    }

    fn note_success(&mut self) {
        *self = Backoff::default();
    }
}

/// One instance lives as long as the service; listeners clone the handle, so
/// `set_required` (per start) and `swap_credentials` (per credential change)
/// are observed by everything serving.
#[derive(Clone)]
pub struct OpdsBasicAuth {
    inner: Arc<AuthInner>,
}

struct AuthInner {
    limits: crate::limits::Limits,
    required: AtomicBool,
    credentials: Mutex<Option<Arc<Vec<DeviceKeyVerifier>>>>,
    backoff: Mutex<Backoff>,
    key_used: Mutex<Option<KeyUsedHook>>,
    reported: Mutex<HashMap<String, Instant>>,
}

impl Default for OpdsBasicAuth {
    fn default() -> Self {
        Self::new()
    }
}

impl OpdsBasicAuth {
    /// The natural constructor for embedders: an auth handle that requires
    /// nothing and trusts no one until `set_required`/`swap_credentials`.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(AuthInner {
                limits: crate::limits::Limits::default(),
                required: AtomicBool::new(false),
                credentials: Mutex::new(None),
                backoff: Mutex::new(Backoff::default()),
                key_used: Mutex::new(None),
                reported: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub(crate) fn limits(&self) -> crate::limits::Limits {
        self.inner.limits.clone()
    }

    pub(crate) fn set_required(&self, required: bool) {
        self.inner.required.store(required, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(crate) fn required(&self) -> bool {
        self.inner.required.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    pub(crate) fn swap_credentials(&self, credentials: Option<DeviceKeyVerifier>) {
        self.swap_credential_list(credentials.into_iter().collect());
    }

    pub(crate) fn set_key_used_hook(&self, hook: KeyUsedHook) {
        *self.inner.key_used.lock().unwrap() = Some(hook);
    }

    pub(crate) fn swap_credential_list(&self, credentials: Vec<DeviceKeyVerifier>) {
        *self.inner.credentials.lock().unwrap() = if credentials.is_empty() {
            None
        } else {
            Some(Arc::new(credentials))
        };
    }

    fn authorize(&self, authorization: Option<&[u8]>) -> AuthOutcome {
        if !self.inner.required.load(Ordering::Relaxed) {
            return AuthOutcome::Authorized(None);
        }

        {
            let backoff = self.inner.backoff.lock().unwrap();
            if backoff.refused_until(Instant::now()).is_some() {
                return AuthOutcome::Backoff;
            }
        }

        let credentials = self.inner.credentials.lock().unwrap().clone();
        let parsed = authorization.and_then(parse_basic_credentials);
        // Every key is checked, so timing doesn't show which one matched.
        let matched = parsed.and_then(|provided| {
            credentials.and_then(|stored| {
                stored.iter().fold(None, |matched, key| {
                    let matches = key.matches(&provided.username, &provided.password);
                    matched.or(matches.then(|| key.key_id.clone()))
                })
            })
        });
        {
            let mut backoff = self.inner.backoff.lock().unwrap();
            if matched.is_some() {
                backoff.note_success();
            } else {
                backoff.note_rejection(Instant::now());
            }
        }
        match matched {
            Some(key_id) => AuthOutcome::Authorized(Some(key_id)),
            None => AuthOutcome::Rejected,
        }
    }

    /// The hook to call for `key_id` now, if one is set and the key's use
    /// hasn't been reported within the interval.
    fn key_use_to_report(&self, key_id: &str, now: Instant) -> Option<KeyUsedHook> {
        let hook = self.inner.key_used.lock().unwrap().clone()?;
        let mut reported = self.inner.reported.lock().unwrap();
        let due = reported
            .get(key_id)
            .is_none_or(|last| now.duration_since(*last) >= KEY_USE_REPORT_INTERVAL);
        if !due {
            return None;
        }
        reported.insert(key_id.to_string(), now);
        Some(hook)
    }
}

enum AuthOutcome {
    /// With the key that signed in, when sign-in was required.
    Authorized(Option<String>),
    Rejected,
    Backoff,
}

/// Axum 0.8 middleware. Apply it as the final layer around the OPDS router.
pub(crate) async fn require_basic_auth(
    State(auth): State<OpdsBasicAuth>,
    request: Request,
    next: Next,
) -> Response {
    if !auth.inner.required.load(Ordering::Relaxed) {
        return next.run(request).await;
    }

    let authorization = request
        .headers()
        .get(AUTHORIZATION)
        .map(|value| value.as_bytes().to_vec());
    match auth.authorize(authorization.as_deref()) {
        AuthOutcome::Authorized(key_id) => {
            if let Some(key_id) = key_id {
                if let Some(hook) = auth.key_use_to_report(&key_id, Instant::now()) {
                    tokio::task::spawn_blocking(move || hook(&key_id));
                }
            }
            next.run(request).await
        }
        AuthOutcome::Backoff => (
            StatusCode::TOO_MANY_REQUESTS,
            [(RETRY_AFTER, HeaderValue::from_static("1"))],
        )
            .into_response(),
        AuthOutcome::Rejected => unauthorized_response(),
    }
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

    fn enabled_auth(username: &str, password: &str) -> OpdsBasicAuth {
        let auth = OpdsBasicAuth::new();
        auth.set_required(true);
        auth.swap_credentials(Some(DeviceKeyVerifier::new("key", username, password)));
        auth
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

    #[tokio::test]
    async fn repeated_failures_throttle_into_a_backoff_window() {
        let auth = enabled_auth("reader", "correct horse");
        let wrong = Some(&basic_header("reader", b"wrong password")[..]);

        for _ in 0..BACKOFF_START_THRESHOLD {
            assert!(matches!(auth.authorize(wrong), AuthOutcome::Rejected));
        }
        // The next attempt is refused without a credential check.
        assert!(matches!(auth.authorize(wrong), AuthOutcome::Backoff));

        // Backoff expires and checks resume.
        tokio::time::sleep(BACKOFF_BASE).await;
        assert!(matches!(auth.authorize(wrong), AuthOutcome::Rejected));
    }

    #[tokio::test]
    async fn successful_authentication_resets_the_backoff_budget() {
        let auth = enabled_auth("reader", "correct horse");
        let right = Some(&basic_header("reader", b"correct horse")[..]);
        let wrong = Some(&basic_header("reader", b"wrong password")[..]);

        for _ in 0..BACKOFF_START_THRESHOLD.saturating_sub(1) {
            assert!(matches!(auth.authorize(wrong), AuthOutcome::Rejected));
        }
        assert!(matches!(auth.authorize(right), AuthOutcome::Authorized(_)));
        // The failure streak was reset: more failures are answered, not refused.
        assert!(matches!(auth.authorize(wrong), AuthOutcome::Rejected));
    }

    #[tokio::test]
    async fn auth_not_required_bypasses_even_malformed_authorization() {
        let auth = OpdsBasicAuth::new();
        auth.swap_credentials(Some(DeviceKeyVerifier::new(
            "key",
            "reader",
            "correct horse",
        )));

        assert!(matches!(
            auth.authorize(Some(b"not even close to Basic")),
            AuthOutcome::Authorized(_)
        ));
        assert_eq!(
            response(auth, Some(b"not even close to Basic".to_vec()))
                .await
                .status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn required_auth_with_no_credentials_rejects_everything() {
        let auth = OpdsBasicAuth::new();
        auth.set_required(true);

        assert!(matches!(
            auth.authorize(Some(&basic_header("reader", b"anything"))),
            AuthOutcome::Rejected
        ));
        assert!(matches!(auth.authorize(None), AuthOutcome::Rejected));
    }

    #[tokio::test]
    async fn enabled_auth_accepts_only_the_configured_basic_credentials() {
        let auth = enabled_auth("reader", "correct horse");

        assert!(matches!(
            auth.authorize(Some(&basic_header("reader", b"correct horse"))),
            AuthOutcome::Authorized(_)
        ));
        assert!(matches!(
            auth.authorize(Some(&basic_header("reader", b"wrong password"))),
            AuthOutcome::Rejected
        ));
        assert!(matches!(
            auth.authorize(Some(&basic_header("someone-else", b"correct horse"))),
            AuthOutcome::Rejected
        ));
        assert!(matches!(auth.authorize(None), AuthOutcome::Rejected));
    }

    #[tokio::test]
    async fn swapping_credentials_takes_effect_on_the_next_request_without_a_restart() {
        let auth = enabled_auth("reader", "first-secret");
        let old = basic_header("reader", b"first-secret");
        let new = basic_header("reader", b"second-secret");

        assert!(matches!(
            auth.authorize(Some(&old)),
            AuthOutcome::Authorized(_)
        ));

        auth.swap_credentials(Some(DeviceKeyVerifier::new(
            "key",
            "reader",
            "second-secret",
        )));

        assert!(matches!(auth.authorize(Some(&old)), AuthOutcome::Rejected));
        assert!(matches!(
            auth.authorize(Some(&new)),
            AuthOutcome::Authorized(_)
        ));

        // A clone of the handle shares the same snapshot.
        let clone = auth.clone();
        auth.swap_credentials(None);
        assert!(matches!(clone.authorize(Some(&new)), AuthOutcome::Rejected));
    }

    #[tokio::test]
    async fn middleware_challenges_missing_and_wrong_credentials_and_allows_correct_ones() {
        let auth = enabled_auth("reader", "correct horse");

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
    async fn backoff_is_answered_with_too_many_requests_and_a_retry_hint() {
        let auth = enabled_auth("reader", "correct horse");
        let wrong = Some(&basic_header("reader", b"wrong password")[..]);

        for _ in 0..BACKOFF_START_THRESHOLD {
            assert!(matches!(auth.authorize(wrong), AuthOutcome::Rejected));
        }

        let refused = response(auth, Some(basic_header("reader", b"wrong password"))).await;
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(refused.headers().get(RETRY_AFTER).unwrap(), "1");
    }

    #[test]
    fn basic_parser_preserves_password_bytes_after_the_first_colon() {
        let header = basic_header("reader", b"pa:ss:word");
        let credentials = parse_basic_credentials(&header).unwrap();

        assert_eq!(credentials.username, "reader");
        assert_eq!(credentials.password, b"pa:ss:word");
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
    #[test]
    fn key_use_is_reported_once_per_interval_per_key() {
        let auth = enabled_auth("reader", "correct horse");
        let now = Instant::now();
        assert!(auth.key_use_to_report("key", now).is_none());
        auth.set_key_used_hook(Arc::new(|_| {}));
        assert!(auth.key_use_to_report("key", now).is_some());
        assert!(auth.key_use_to_report("key", now).is_none());
        assert!(auth.key_use_to_report("other", now).is_some());
        assert!(auth
            .key_use_to_report("key", now + KEY_USE_REPORT_INTERVAL)
            .is_some());
    }

    #[test]
    fn multiple_users_have_independent_passwords() {
        let auth = OpdsBasicAuth::new();
        auth.set_required(true);
        auth.swap_credential_list(vec![
            DeviceKeyVerifier::new("alice-kobo", "alice", "one"),
            DeviceKeyVerifier::new("bob-kobo", "bob", "two:three"),
            DeviceKeyVerifier::new("bob-phone", "bob", "four"),
        ]);
        for (user, password, key) in [
            ("alice", "one", "alice-kobo"),
            ("bob", "two:three", "bob-kobo"),
            ("bob", "four", "bob-phone"),
        ] {
            assert!(matches!(
                auth.authorize(Some(&basic_header(user, password.as_bytes()))),
                AuthOutcome::Authorized(Some(id)) if id == key
            ));
        }
        assert!(matches!(
            auth.authorize(Some(&basic_header("alice", b"two:three"))),
            AuthOutcome::Rejected
        ));
        assert!(matches!(
            auth.authorize(Some(&basic_header("bob", b"two:three"))),
            AuthOutcome::Authorized(_)
        ));
    }
}
