//! HTTP Basic authentication for the OPDS server.
//!
//! The credential snapshot is hot-swappable: listeners read it per request,
//! so creating, rotating or revoking device keys never interrupts a running
//! share. The snapshot holds salted hashes, never keys (ADR 0013). Every
//! guess goes through the sign-in guard (ADR 0017), which limits each client
//! and each username; readers that signed in before keep working while their
//! username is guessed at from elsewhere.

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

use crate::{
    client::ClientAddress,
    guard::{Credential, Outcome, Refusal, SignInGuard},
};

const BASIC_CHALLENGE: &str = "Basic realm=\"Citadel\", charset=\"UTF-8\"";
/// How often a key's use is reported to the host, so busy readers (every
/// cover is a request) don't write to the host's database each time.
const KEY_USE_REPORT_INTERVAL: Duration = Duration::from_secs(60 * 60);

pub(crate) type KeyUsedHook = Arc<dyn Fn(&str) + Send + Sync>;

/// One instance lives as long as the service; listeners clone the handle, so
/// `set_required` (per start) and `swap_credentials` (per credential change)
/// are observed by everything serving.
#[derive(Clone)]
pub struct OpdsBasicAuth {
    inner: Arc<AuthInner>,
}

struct AuthInner {
    required: AtomicBool,
    credentials: Mutex<Option<Arc<Vec<DeviceKeyVerifier>>>>,
    guard: SignInGuard,
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
                required: AtomicBool::new(false),
                credentials: Mutex::new(None),
                guard: SignInGuard::new(),
                key_used: Mutex::new(None),
                reported: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// The guard every OPDS guess goes through; hosts share it with their
    /// other ways of signing in.
    pub fn guard(&self) -> &SignInGuard {
        &self.inner.guard
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

    fn authorize(&self, authorization: Option<&[u8]>, client: &ClientAddress) -> AuthOutcome {
        if !self.inner.required.load(Ordering::Relaxed) {
            return AuthOutcome::Authorized(None);
        }
        // A request without credentials is how readers learn sign-in is
        // needed: challenged, not counted.
        let Some(authorization) = authorization else {
            return AuthOutcome::Rejected;
        };
        let parsed = parse_basic_credentials(authorization);
        let credential = Credential::DeviceKey {
            username: parsed
                .as_ref()
                .map(|provided| provided.username.as_str())
                .filter(|username| !username.trim().is_empty()),
            key: parsed
                .as_ref()
                .map_or(authorization, |provided| provided.password.as_slice()),
        };
        let ticket = match self.inner.guard.reserve(client, credential) {
            Ok(ticket) => ticket,
            Err(refusal) if refusal.is_repeat() => return AuthOutcome::Rejected,
            Err(refusal) => return AuthOutcome::Refused(refusal),
        };
        let credentials = self.inner.credentials.lock().unwrap().clone();
        // Every key is checked, so timing doesn't show which one matched.
        let matched = parsed
            .filter(|provided| !provided.username.trim().is_empty())
            .and_then(|provided| {
                credentials.and_then(|stored| {
                    stored.iter().fold(None, |matched, key| {
                        let matches = key.matches(&provided.username, &provided.password);
                        matched.or(matches.then(|| key.key_id.clone()))
                    })
                })
            });
        match matched {
            Some(key_id) => {
                ticket.settle(Outcome::Success);
                AuthOutcome::Authorized(Some(key_id))
            }
            None => {
                ticket.settle(Outcome::Failure);
                AuthOutcome::Rejected
            }
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
    Refused(Refusal),
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
    let client = ClientAddress::of(request.extensions());
    match auth.authorize(authorization.as_deref(), &client) {
        AuthOutcome::Authorized(key_id) => {
            if let Some(key_id) = key_id {
                if let Some(hook) = auth.key_use_to_report(&key_id, Instant::now()) {
                    tokio::task::spawn_blocking(move || hook(&key_id));
                }
            }
            next.run(request).await
        }
        AuthOutcome::Refused(refusal) => (
            StatusCode::TOO_MANY_REQUESTS,
            [(
                RETRY_AFTER,
                HeaderValue::from(refusal.retry_after_seconds()),
            )],
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

    /// Requests made in-process: this machine, never soft.
    fn local() -> ClientAddress {
        ClientAddress::in_process()
    }

    fn wrong(attempt: usize) -> Vec<u8> {
        basic_header("reader", format!("wrong password {attempt}").as_bytes())
    }

    #[tokio::test]
    async fn wrong_keys_count_against_the_address_but_bare_requests_do_not() {
        let auth = enabled_auth("reader", "correct horse");
        for _ in 0..500 {
            assert!(matches!(
                auth.authorize(None, &local()),
                AuthOutcome::Rejected
            ));
        }
        let reader = ClientAddress::direct("203.0.113.7:1".parse().unwrap());
        for attempt in 0..100 {
            let name = format!("reader{attempt}");
            let header = basic_header(&name, b"wrong");
            assert!(matches!(
                auth.authorize(Some(&header), &reader),
                AuthOutcome::Rejected
            ));
        }
        // The next guess is refused without a check, for the real wait.
        assert!(matches!(
            auth.authorize(Some(&basic_header("reader", b"correct horse")), &reader),
            AuthOutcome::Refused(refusal) if refusal.retry_after_seconds() == 3600
        ));
        // Malformed headers and empty usernames count as failures too.
        let other = ClientAddress::direct("203.0.113.8:1".parse().unwrap());
        for attempt in 0..100 {
            let header = if attempt % 2 == 0 {
                format!("Basic not-base64-{attempt}").into_bytes()
            } else {
                basic_header("", format!("key {attempt}").as_bytes())
            };
            assert!(matches!(
                auth.authorize(Some(&header), &other),
                AuthOutcome::Rejected
            ));
        }
        assert!(matches!(
            auth.authorize(Some(&basic_header("reader", b"correct horse")), &other),
            AuthOutcome::Refused(_)
        ));
        assert!(matches!(
            auth.authorize(Some(&basic_header("reader", b"correct horse")), &local()),
            AuthOutcome::Authorized(_)
        ));
    }

    #[tokio::test]
    async fn success_gives_its_own_guess_back_without_forgiving_failures() {
        let auth = enabled_auth("reader", "correct horse");
        let right = Some(&basic_header("reader", b"correct horse")[..]);
        for attempt in 0..9 {
            assert!(matches!(
                auth.authorize(Some(&wrong(attempt)), &local()),
                AuthOutcome::Rejected
            ));
        }
        for _ in 0..50 {
            assert!(matches!(
                auth.authorize(right, &local()),
                AuthOutcome::Authorized(_)
            ));
        }
        let third = ClientAddress::direct("198.51.100.3:1".parse().unwrap());
        assert!(matches!(
            auth.authorize(Some(&wrong(9)), &third),
            AuthOutcome::Rejected
        ));
        // The username's ten guesses are spent; this reader's address is
        // known, so it keeps signing in.
        let elsewhere = ClientAddress::direct("203.0.113.9:1".parse().unwrap());
        assert!(matches!(
            auth.authorize(right, &elsewhere),
            AuthOutcome::Refused(_)
        ));
        assert!(matches!(
            auth.authorize(right, &local()),
            AuthOutcome::Authorized(_)
        ));
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
            auth.authorize(Some(b"not even close to Basic"), &local()),
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
            auth.authorize(Some(&basic_header("reader", b"anything")), &local()),
            AuthOutcome::Rejected
        ));
        assert!(matches!(
            auth.authorize(None, &local()),
            AuthOutcome::Rejected
        ));
    }

    #[tokio::test]
    async fn enabled_auth_accepts_only_the_configured_basic_credentials() {
        let auth = enabled_auth("reader", "correct horse");

        assert!(matches!(
            auth.authorize(Some(&basic_header("reader", b"correct horse")), &local()),
            AuthOutcome::Authorized(_)
        ));
        assert!(matches!(
            auth.authorize(Some(&basic_header("reader", b"wrong password")), &local()),
            AuthOutcome::Rejected
        ));
        assert!(matches!(
            auth.authorize(
                Some(&basic_header("someone-else", b"correct horse")),
                &local()
            ),
            AuthOutcome::Rejected
        ));
        assert!(matches!(
            auth.authorize(None, &local()),
            AuthOutcome::Rejected
        ));
    }

    #[test]
    fn usernames_match_ignoring_case_but_keys_do_not() {
        let auth = enabled_auth("reader", "correct horse");

        assert!(matches!(
            auth.authorize(Some(&basic_header("READER", b"correct horse")), &local()),
            AuthOutcome::Authorized(Some(_))
        ));
        assert!(matches!(
            auth.authorize(Some(&basic_header("reader", b"CORRECT HORSE")), &local()),
            AuthOutcome::Rejected
        ));
    }

    #[tokio::test]
    async fn swapping_credentials_takes_effect_on_the_next_request_without_a_restart() {
        let auth = enabled_auth("reader", "first-secret");
        let old = basic_header("reader", b"first-secret");
        let new = basic_header("reader", b"second-secret");

        assert!(matches!(
            auth.authorize(Some(&old), &local()),
            AuthOutcome::Authorized(_)
        ));

        auth.swap_credentials(Some(DeviceKeyVerifier::new(
            "key",
            "reader",
            "second-secret",
        )));

        assert!(matches!(
            auth.authorize(Some(&old), &local()),
            AuthOutcome::Rejected
        ));
        assert!(matches!(
            auth.authorize(Some(&new), &local()),
            AuthOutcome::Authorized(_)
        ));

        // A clone of the handle shares the same snapshot.
        let clone = auth.clone();
        auth.swap_credentials(None);
        assert!(matches!(
            clone.authorize(Some(&new), &local()),
            AuthOutcome::Rejected
        ));
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
    async fn refusals_are_answered_with_too_many_requests_and_the_real_wait() {
        let auth = enabled_auth("reader", "correct horse");
        for attempt in 0..10 {
            assert!(matches!(
                auth.authorize(Some(&wrong(attempt)), &local()),
                AuthOutcome::Rejected
            ));
        }

        let refused = response(auth, Some(wrong(10))).await;
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(refused.headers().get(RETRY_AFTER).unwrap(), "30");
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
                auth.authorize(Some(&basic_header(user, password.as_bytes())), &local()),
                AuthOutcome::Authorized(Some(id)) if id == key
            ));
        }
        assert!(matches!(
            auth.authorize(Some(&basic_header("alice", b"two:three")), &local()),
            AuthOutcome::Rejected
        ));
        assert!(matches!(
            auth.authorize(Some(&basic_header("bob", b"two:three")), &local()),
            AuthOutcome::Authorized(_)
        ));
    }
}
