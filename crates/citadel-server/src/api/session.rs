//! Browser sign-in. Sessions are server-side rows keyed by an opaque cookie;
//! the user and their library grant are looked up on every request.
use std::sync::{Arc, Mutex};

use axum::{
    extract::{rejection::JsonRejection, Extension, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use citadel_core::error::{LibraryError, LibraryErrorCode};
use citadel_opds::{
    client::ClientAddress,
    guard::{Credential, DeviceCookies, Outcome, Refusal, SignInGuard, DEVICE_COOKIE_LIFETIME},
    verifier::{Lane, VerifierPool},
};
use serde::{Deserialize, Serialize};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::{
    addresses::{Addresses, RequestOrigin},
    ApiFailure, ApiState,
};
use crate::served::{no_library_yet, ServedLibrary};
use citadel_core::store::{CitadelStore, LibraryPermission, User, SESSION_TTL_SECONDS};

pub const SESSION_COOKIE: &str = "citadel_session";
/// Marks a browser that signed in before, so an attack on its username
/// doesn't lock it out (ADR 0017). Sent only to sign-in.
pub const DEVICE_COOKIE: &str = "citadel_device";

/// An origin browsers use to reach Citadel, such as
/// `https://books.example.com`. Its scheme decides whether the session
/// cookie is `Secure`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicUrl {
    origin: String,
    secure: bool,
    host: String,
}

impl PublicUrl {
    pub fn parse(value: &str) -> Result<Self, String> {
        let invalid = || {
            format!(
                "api.publicUrls must be http(s) origins browsers use to reach Citadel, \
                 such as \"https://books.example.com\" (got {value:?})"
            )
        };
        let uri: axum::http::Uri = value.parse().map_err(|_| invalid())?;
        let secure = match uri.scheme_str() {
            Some("https") => true,
            Some("http") => false,
            _ => return Err(invalid()),
        };
        let authority = uri.authority().ok_or_else(invalid)?;
        if authority.as_str().contains('@')
            || !matches!(uri.path(), "" | "/")
            || uri.query().is_some()
        {
            return Err(invalid());
        }
        // Browsers omit the scheme's default port from `Origin`.
        let default_port = if secure { 443 } else { 80 };
        let port = authority
            .port_u16()
            .filter(|port| *port != default_port)
            .map(|port| format!(":{port}"))
            .unwrap_or_default();
        let host = authority.host().to_ascii_lowercase();
        Ok(Self {
            origin: format!("{}://{host}{port}", uri.scheme_str().unwrap_or_default()),
            secure,
            host,
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn secure(&self) -> bool {
        self.secure
    }

    /// This machine: `localhost` or a loopback address.
    pub fn is_loopback(&self) -> bool {
        self.host == "localhost"
            || self.host.ends_with(".localhost")
            || self
                .host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    }
}

pub(super) struct Access {
    pub accounts: Arc<CitadelStore>,
    pub served: Arc<ServedLibrary>,
    pub addresses: Arc<Addresses>,
    /// Every guess at a password, setup code or OPDS device key goes
    /// through it.
    pub guard: SignInGuard,
    /// The only threads that check passwords.
    pub verifier: VerifierPool,
    devices: DeviceCookies,
    /// Printed at startup while no administrator exists; cleared once used.
    setup_code: Mutex<Option<String>>,
}

impl Access {
    pub fn new(
        accounts: Arc<CitadelStore>,
        served: Arc<ServedLibrary>,
        addresses: Arc<Addresses>,
        setup_code: Option<String>,
        guard: SignInGuard,
        verifier: VerifierPool,
    ) -> Self {
        let secret = accounts.device_cookie_secret().unwrap_or_else(|error| {
            eprintln!(
                "citadel_server warning=\"could not read the known-device key, so browsers are \
                 known only until the server restarts: {error}\""
            );
            let mut secret = [0u8; 32];
            secret[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
            secret[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
            secret
        });
        Self {
            accounts,
            served,
            addresses,
            guard,
            verifier,
            devices: DeviceCookies::new(secret),
            setup_code: Mutex::new(setup_code),
        }
    }

    pub fn setup_code(&self) -> Option<String> {
        self.setup_code
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn consume_setup_code(&self) {
        *self
            .setup_code
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }
}

/// What the session's user may do with the served library.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum LibraryAccess {
    Granted(LibraryPermission),
    Denied,
    /// No library is set up yet, so there is nothing to grant.
    NoLibrary,
}

/// The signed-in user, available to handlers behind [`require_session`]; write
/// handlers derive their `Actor` from it.
#[derive(Clone, Debug)]
pub(super) struct SignedIn(pub User);

#[derive(Serialize, utoipa::ToSchema)]
pub(super) struct SessionUser {
    id: String,
    username: String,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionInfo {
    user: SessionUser,
    /// False when the user exists but has no access to this server's library,
    /// or no library is set up yet.
    library_access: bool,
    /// May set the server up and administer it.
    administrator: bool,
}

impl SessionInfo {
    pub fn new(user: &User, library_access: bool) -> Self {
        Self {
            user: SessionUser {
                id: user.id.clone(),
                username: user.username.clone(),
            },
            library_access,
            administrator: user.is_administrator(),
        }
    }
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct SignInRequest {
    username: String,
    password: String,
}

fn failure(code: LibraryErrorCode, message: &str) -> ApiFailure {
    LibraryError {
        code,
        message: message.into(),
    }
    .into()
}

pub(super) fn cross_origin_refused() -> Response {
    let error = LibraryError {
        code: LibraryErrorCode::Unauthorized,
        message: "Cross-origin request refused".into(),
    };
    (StatusCode::FORBIDDEN, Json(error)).into_response()
}

pub(super) fn signed_out() -> ApiFailure {
    failure(LibraryErrorCode::Unauthorized, "Sign in to Citadel")
}

fn session_token(headers: &HeaderMap) -> Option<String> {
    cookie(headers, SESSION_COOKIE)
}

fn cookie(headers: &HeaderMap, wanted: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, value)| *name == wanted && !value.is_empty())
        .map(|(_, value)| value.to_string())
}

/// 429 with how long until the guess could be checked.
pub(super) fn too_many_attempts(refusal: Refusal, message: &str) -> Response {
    let mut response = failure(LibraryErrorCode::RateLimited, message).into_response();
    response.headers_mut().insert(
        header::RETRY_AFTER,
        HeaderValue::from(refusal.retry_after_seconds()),
    );
    response
}

/// The known-device cookie, sent back to sign-in only.
fn device_cookie(origin: Option<&RequestOrigin>, value: &str) -> HeaderValue {
    let secure = origin.is_some_and(|RequestOrigin(origin)| origin.secure);
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{DEVICE_COOKIE}={value}; Path=/api/session; HttpOnly; SameSite=Lax; Max-Age={}{secure}",
        DEVICE_COOKIE_LIFETIME.as_secs()
    ))
    .expect("device cookies are ASCII")
}

/// Cookie-authenticated requests that change state must come from the page
/// at the address they were sent to (itself one Citadel allows, see
/// `addresses`). Browsers always send `Origin` on such requests.
pub(super) fn cross_origin(
    origin: Option<&RequestOrigin>,
    request_method: &Method,
    headers: &HeaderMap,
) -> bool {
    if matches!(
        *request_method,
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        return false;
    }
    headers
        .get(header::ORIGIN)
        .is_some_and(|sent| match origin {
            Some(RequestOrigin(origin)) => !sent
                .as_bytes()
                .eq_ignore_ascii_case(origin.origin.as_bytes()),
            None => true,
        })
}

/// The session cookie for the address the request used: `Secure` over HTTPS.
pub(super) fn session_cookie(
    origin: Option<&RequestOrigin>,
    value: &str,
    max_age: i64,
) -> HeaderValue {
    let secure = origin.is_some_and(|RequestOrigin(origin)| origin.secure);
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"
    ))
    .expect("session cookies are ASCII")
}

pub(super) async fn blocking<T: Send + 'static>(
    state: &ApiState,
    operation: impl FnOnce(&CitadelStore) -> Result<T, citadel_core::store::StoreError> + Send + 'static,
) -> Result<T, ApiFailure> {
    let permit = state
        .work
        .clone()
        .try_acquire_owned()
        .map_err(|_| LibraryError::unavailable())?;
    let accounts = state.access.accounts.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        operation(&accounts)
    })
    .await
    .map_err(|_| LibraryError::unavailable())?
    .map_err(|error| ApiFailure::from(crate::served::store_error(error)))
}

pub(super) async fn current_user(
    state: &ApiState,
    headers: &HeaderMap,
) -> Result<Option<(User, LibraryAccess)>, ApiFailure> {
    let Some(token) = session_token(headers) else {
        return Ok(None);
    };
    let library_id = state.access.served.library_id();
    blocking(state, move |accounts| {
        let Some(user) = accounts.session_user(&token)? else {
            return Ok(None);
        };
        let access = library_access(accounts, &user, library_id.as_deref())?;
        Ok(Some((user, access)))
    })
    .await
}

fn library_access(
    accounts: &CitadelStore,
    user: &User,
    library_id: Option<&str>,
) -> Result<LibraryAccess, citadel_core::store::StoreError> {
    Ok(match library_id {
        None => LibraryAccess::NoLibrary,
        Some(library_id) => match accounts.library_permission(&user.id, library_id)? {
            Some(permission) => LibraryAccess::Granted(permission),
            None => LibraryAccess::Denied,
        },
    })
}

fn clear_cookie(origin: Option<&RequestOrigin>, response: &mut Response) {
    response
        .headers_mut()
        .append(header::SET_COOKIE, session_cookie(origin, "", 0));
}

/// Requires a signed-in user with a grant to the served library. Libraries a
/// user can't access are invisible: they answer 404, never 403.
pub(super) async fn require_session(
    State(state): State<ApiState>,
    mut request: Request,
    next: Next,
) -> Response {
    let origin = request.extensions().get::<RequestOrigin>().cloned();
    if cross_origin(origin.as_ref(), request.method(), request.headers()) {
        return cross_origin_refused();
    }
    let had_cookie = session_token(request.headers()).is_some();
    match current_user(&state, request.headers()).await {
        Ok(Some((user, LibraryAccess::Granted(permission)))) => {
            request.extensions_mut().insert(SignedIn(user));
            request.extensions_mut().insert(permission);
            next.run(request).await
        }
        Ok(Some((_, LibraryAccess::Denied))) => failure(
            LibraryErrorCode::NotFound,
            "No library is available to this account",
        )
        .into_response(),
        Ok(Some((_, LibraryAccess::NoLibrary))) => {
            ApiFailure::from(no_library_yet()).into_response()
        }
        Ok(None) => {
            let mut response = signed_out().into_response();
            if had_cookie {
                clear_cookie(origin.as_ref(), &mut response);
            }
            response
        }
        Err(error) => error.into_response(),
    }
}

#[utoipa::path(get, path = "/api/session", operation_id = "getSession",
    description = "The signed-in user, or 401 when the browser has no valid session.",
    responses((status = 200, body = SessionInfo), (status = 401, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)))]
async fn get_session(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<SessionInfo>, ApiFailure> {
    let (user, library_access) = current_user(&state, &headers)
        .await?
        .ok_or_else(signed_out)?;
    Ok(Json(SessionInfo::new(
        &user,
        matches!(library_access, LibraryAccess::Granted(_)),
    )))
}

#[utoipa::path(post, path = "/api/session", operation_id = "signIn",
    request_body = SignInRequest,
    description = "Sign in with a Citadel username and password. Sets an HttpOnly session cookie.",
    responses((status = 200, body = SessionInfo), (status = 400, body = LibraryError),
        (status = 401, body = LibraryError), (status = 403, body = LibraryError),
        (status = 429, body = LibraryError), (status = 503, body = LibraryError), (status = 500, body = LibraryError)))]
async fn sign_in(
    State(state): State<ApiState>,
    origin: Option<Extension<RequestOrigin>>,
    client: ClientAddress,
    method: Method,
    headers: HeaderMap,
    input: Result<Json<SignInRequest>, JsonRejection>,
) -> Response {
    let origin = origin.map(|Extension(origin)| origin);
    if cross_origin(origin.as_ref(), &method, &headers) {
        return cross_origin_refused();
    }
    let Ok(Json(input)) = input else {
        return ApiFailure::from(LibraryError::invalid("Invalid sign-in JSON")).into_response();
    };
    let access = &state.access;
    let now = chrono::Utc::now().timestamp();
    let device = cookie(&headers, DEVICE_COOKIE)
        .and_then(|value| access.devices.recognise(&value, &input.username, now));
    let ticket = match access.guard.reserve(
        &client,
        Credential::Password {
            username: &input.username,
            password: input.password.as_bytes(),
            device,
        },
    ) {
        Ok(ticket) => ticket,
        Err(refusal) if refusal.is_repeat() => {
            return failure(
                LibraryErrorCode::Unauthorized,
                "Incorrect username or password",
            )
            .into_response();
        }
        Err(refusal) => return too_many_attempts(refusal, "Too many sign-in attempts"),
    };
    let username = input.username.clone();
    let stored = match blocking(&state, move |accounts| accounts.lookup_hash(&username)).await {
        Ok(stored) => stored,
        Err(error) => {
            ticket.refund();
            return error.into_response();
        }
    };
    let lane = Lane::of(&ticket, &client);
    let password = input.password;
    let checked = access.verifier.submit(lane, ticket, move |ticket| {
        let user = stored.verify(&password);
        ticket.settle(if user.is_some() {
            Outcome::Success
        } else {
            Outcome::Failure
        });
        user
    });
    let user = match checked {
        Ok(checked) => checked.await,
        Err(_) => return ApiFailure::from(LibraryError::unavailable()).into_response(),
    };
    let Ok(user) = user else {
        return ApiFailure::from(LibraryError::unavailable()).into_response();
    };
    let Some(user) = user else {
        return failure(
            LibraryErrorCode::Unauthorized,
            "Incorrect username or password",
        )
        .into_response();
    };
    let library_id = state.access.served.library_id();
    let signed_in = user.clone();
    let created = blocking(&state, move |accounts| {
        let token = accounts.create_session(&signed_in.id)?;
        let access = library_access(accounts, &signed_in, library_id.as_deref())?;
        Ok((token, access))
    })
    .await;
    let (token, library_access) = match created {
        Ok(created) => created,
        Err(error) => return error.into_response(),
    };
    let mut response = Json(SessionInfo::new(
        &user,
        matches!(library_access, LibraryAccess::Granted(_)),
    ))
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        session_cookie(origin.as_ref(), &token, SESSION_TTL_SECONDS),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        device_cookie(origin.as_ref(), &access.devices.issue(&user.username, now)),
    );
    response
}

#[utoipa::path(delete, path = "/api/session", operation_id = "signOut",
    description = "End this browser's session and clear its cookie.",
    responses((status = 204), (status = 403, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)))]
async fn sign_out(
    State(state): State<ApiState>,
    origin: Option<Extension<RequestOrigin>>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let origin = origin.map(|Extension(origin)| origin);
    if cross_origin(origin.as_ref(), &method, &headers) {
        return cross_origin_refused();
    }
    if let Some(token) = session_token(&headers) {
        if let Err(error) = blocking(&state, move |accounts| accounts.delete_session(&token)).await
        {
            return error.into_response();
        }
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    clear_cookie(origin.as_ref(), &mut response);
    response
}

pub(super) fn routes() -> OpenApiRouter<ApiState> {
    OpenApiRouter::new().routes(routes!(get_session, sign_in, sign_out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_urls_are_origins_and_decide_cookie_security() {
        let https = PublicUrl::parse("https://Books.Example.com/").unwrap();
        assert_eq!(https.origin, "https://books.example.com");
        assert!(https.secure());
        assert!(!https.is_loopback());
        assert!(
            session_cookie(Some(&RequestOrigin(https.clone())), "token", 60)
                .to_str()
                .unwrap()
                .ends_with("; Secure")
        );
        assert_eq!(
            PublicUrl::parse("https://books.example.com:443").unwrap(),
            https
        );
        let http = PublicUrl::parse("http://127.0.0.1:8081").unwrap();
        assert_eq!(http.origin, "http://127.0.0.1:8081");
        assert!(http.is_loopback());
        assert!(!session_cookie(Some(&RequestOrigin(http)), "token", 60)
            .to_str()
            .unwrap()
            .contains("Secure"));
        assert!(!session_cookie(None, "token", 60)
            .to_str()
            .unwrap()
            .contains("Secure"));
        for invalid in [
            "books.example.com",
            "ftp://books.example.com",
            "https://books.example.com/citadel",
            "https://reader@books.example.com",
            "https://books.example.com/?a=b",
        ] {
            assert!(PublicUrl::parse(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn session_cookie_is_found_among_others() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::COOKIE,
            "theme=dark; citadel_session=abc".parse().unwrap(),
        );
        assert_eq!(session_token(&headers).as_deref(), Some("abc"));
        headers.clear();
        headers.append(header::COOKIE, "citadel_session=".parse().unwrap());
        assert_eq!(session_token(&headers), None);
    }

    #[test]
    fn the_device_cookie_goes_only_to_sign_in_and_follows_the_scheme() {
        let https = RequestOrigin(PublicUrl::parse("https://books.example.com").unwrap());
        let cookie = device_cookie(Some(&https), "value");
        let cookie = cookie.to_str().unwrap();
        for attribute in [
            "citadel_device=value",
            "Path=/api/session",
            "HttpOnly",
            "SameSite=Lax",
            "Secure",
        ] {
            assert!(cookie.contains(attribute), "{cookie}");
        }
        assert!(!device_cookie(None, "value")
            .to_str()
            .unwrap()
            .contains("Secure"));
    }
}
