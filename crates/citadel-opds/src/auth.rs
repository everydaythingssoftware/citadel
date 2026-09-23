//! HTTP Basic authentication for the OPDS server.
//!
//! The credential snapshot is hot-swappable: listeners read it per request,
//! so rotating or replacing credentials never interrupts a running share
//! (see ADR 0005 for why the secret is stored reversibly). Consecutive
//! rejections back off exponentially, which is the online-guessing defense.

use std::{
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
use subtle::ConstantTimeEq;

const BASIC_CHALLENGE: &str = "Basic realm=\"Citadel\", charset=\"UTF-8\"";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OpdsAuthCredentials {
    pub username: String,
    pub password: String,
}

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
    required: AtomicBool,
    credentials: Mutex<Option<Arc<OpdsAuthCredentials>>>,
    backoff: Mutex<Backoff>,
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
                required: AtomicBool::new(false),
                credentials: Mutex::new(None),
                backoff: Mutex::new(Backoff::default()),
            }),
        }
    }

    pub(crate) fn set_required(&self, required: bool) {
        self.inner.required.store(required, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(crate) fn required(&self) -> bool {
        self.inner.required.load(Ordering::Relaxed)
    }

    pub(crate) fn swap_credentials(&self, credentials: Option<OpdsAuthCredentials>) {
        *self.inner.credentials.lock().unwrap() = credentials.map(Arc::new);
    }

    fn authorize(&self, authorization: Option<&[u8]>) -> AuthOutcome {
        if !self.inner.required.load(Ordering::Relaxed) {
            return AuthOutcome::Authorized;
        }

        {
            let backoff = self.inner.backoff.lock().unwrap();
            if backoff.refused_until(Instant::now()).is_some() {
                return AuthOutcome::Backoff;
            }
        }

        let credentials = self.inner.credentials.lock().unwrap().clone();
        let parsed = authorization.and_then(parse_basic_credentials);
        let authorized = parsed
            .is_some_and(|provided| credentials.is_some_and(|stored| stored.matches(&provided)));
        {
            let mut backoff = self.inner.backoff.lock().unwrap();
            if authorized {
                backoff.note_success();
            } else {
                backoff.note_rejection(Instant::now());
            }
        }
        if authorized {
            AuthOutcome::Authorized
        } else {
            AuthOutcome::Rejected
        }
    }
}

impl OpdsAuthCredentials {
    /// Constant-time on both fields so response timing never reveals which
    /// characters of a guess were right. (Length is still observable from
    /// the compare itself; at 30.5 bits of generated entropy that is noise.)
    fn matches(&self, provided: &BasicCredentials) -> bool {
        let username = self.username.as_bytes().ct_eq(provided.username.as_bytes());
        let password = self.password.as_bytes().ct_eq(&provided.password);
        bool::from(username & password)
    }
}

enum AuthOutcome {
    Authorized,
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
        AuthOutcome::Authorized => next.run(request).await,
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
        auth.swap_credentials(Some(OpdsAuthCredentials {
            username: username.to_string(),
            password: password.to_string(),
        }));
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
        assert!(matches!(auth.authorize(right), AuthOutcome::Authorized));
        // The failure streak was reset: more failures are answered, not refused.
        assert!(matches!(auth.authorize(wrong), AuthOutcome::Rejected));
    }

    #[tokio::test]
    async fn auth_not_required_bypasses_even_malformed_authorization() {
        let auth = OpdsBasicAuth::new();
        auth.swap_credentials(Some(OpdsAuthCredentials {
            username: "reader".to_string(),
            password: "correct horse".to_string(),
        }));

        assert!(matches!(
            auth.authorize(Some(b"not even close to Basic")),
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
            AuthOutcome::Authorized
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
            AuthOutcome::Authorized
        ));

        auth.swap_credentials(Some(OpdsAuthCredentials {
            username: "reader".to_string(),
            password: "second-secret".to_string(),
        }));

        assert!(matches!(auth.authorize(Some(&old)), AuthOutcome::Rejected));
        assert!(matches!(
            auth.authorize(Some(&new)),
            AuthOutcome::Authorized
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
}
