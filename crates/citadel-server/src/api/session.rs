//! Browser sign-in. Sessions are server-side rows keyed by an opaque cookie;
//! the user and their library grant are looked up on every request.
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    extract::{rejection::JsonRejection, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use citadel_core::error::{LibraryError, LibraryErrorCode};
use serde::{Deserialize, Serialize};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::{ApiFailure, ApiState};
use citadel_core::store::{CitadelStore, User, SESSION_TTL_SECONDS};

pub const SESSION_COOKIE: &str = "citadel_session";

/// The origin browsers use to reach Citadel. Its scheme decides whether the
/// session cookie is `Secure`; unsafe requests must come from this origin.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublicUrl {
    origin: String,
    secure: bool,
}

impl PublicUrl {
    pub fn parse(value: &str) -> Result<Self, String> {
        let invalid = || {
            format!(
                "api.publicUrl must be the http(s) origin browsers use to reach Citadel, \
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
        Ok(Self {
            origin: format!(
                "{}://{}{port}",
                uri.scheme_str().unwrap_or_default(),
                authority.host().to_ascii_lowercase()
            ),
            secure,
        })
    }

    fn cookie(&self, value: &str, max_age: i64) -> HeaderValue {
        let secure = if self.secure { "; Secure" } else { "" };
        HeaderValue::from_str(&format!(
            "{SESSION_COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"
        ))
        .expect("session cookies are ASCII")
    }
}

pub(super) struct Access {
    pub accounts: Arc<CitadelStore>,
    pub library_id: String,
    pub public_url: PublicUrl,
    backoff: Mutex<Backoff>,
}

impl Access {
    pub fn new(accounts: Arc<CitadelStore>, library_id: String, public_url: PublicUrl) -> Self {
        Self {
            accounts,
            library_id,
            public_url,
            backoff: Mutex::default(),
        }
    }
}

/// Consecutive failed sign-ins back off exponentially, as OPDS Basic does.
#[derive(Default)]
struct Backoff {
    consecutive_failures: u32,
    until: Option<Instant>,
}

impl Backoff {
    fn refused(&self, now: Instant) -> bool {
        self.until.is_some_and(|until| until > now)
    }

    fn note(&mut self, success: bool, now: Instant) {
        if success {
            *self = Self::default();
            return;
        }
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if self.consecutive_failures >= 3 {
            let shift = (self.consecutive_failures - 3).min(5);
            self.until = Some(now + Duration::from_secs(2 << shift).min(Duration::from_secs(60)));
        }
    }
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
    /// False when the user exists but has no access to this server's library.
    library_access: bool,
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

fn cross_origin_refused() -> Response {
    let error = LibraryError {
        code: LibraryErrorCode::Unauthorized,
        message: "Cross-origin request refused".into(),
    };
    (StatusCode::FORBIDDEN, Json(error)).into_response()
}

fn signed_out() -> ApiFailure {
    failure(LibraryErrorCode::Unauthorized, "Sign in to Citadel")
}

fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, value)| *name == SESSION_COOKIE && !value.is_empty())
        .map(|(_, value)| value.to_string())
}

/// Cookie-authenticated requests that change state must come from the
/// configured origin. Browsers always send `Origin` on such requests.
fn cross_origin(access: &Access, request_method: &Method, headers: &HeaderMap) -> bool {
    if matches!(
        *request_method,
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        return false;
    }
    headers.get(header::ORIGIN).is_some_and(|origin| {
        !origin
            .as_bytes()
            .eq_ignore_ascii_case(access.public_url.origin.as_bytes())
    })
}

async fn blocking<T: Send + 'static>(
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
    .map_err(|_| {
        ApiFailure::from(LibraryError {
            code: LibraryErrorCode::Internal,
            message: "Account lookup failed".into(),
        })
    })
}

async fn current_user(
    state: &ApiState,
    headers: &HeaderMap,
) -> Result<Option<(User, bool)>, ApiFailure> {
    let Some(token) = session_token(headers) else {
        return Ok(None);
    };
    let library_id = state.access.library_id.clone();
    blocking(state, move |accounts| {
        let Some(user) = accounts.session_user(&token)? else {
            return Ok(None);
        };
        let access = accounts.can_access(&user.id, &library_id)?;
        Ok(Some((user, access)))
    })
    .await
}

fn clear_cookie(access: &Access, response: &mut Response) {
    response
        .headers_mut()
        .append(header::SET_COOKIE, access.public_url.cookie("", 0));
}

/// Requires a signed-in user with a grant to the served library. Libraries a
/// user can't access are invisible: they answer 404, never 403.
pub(super) async fn require_session(
    State(state): State<ApiState>,
    mut request: Request,
    next: Next,
) -> Response {
    if cross_origin(&state.access, request.method(), request.headers()) {
        return cross_origin_refused();
    }
    let had_cookie = session_token(request.headers()).is_some();
    match current_user(&state, request.headers()).await {
        Ok(Some((user, true))) => {
            request.extensions_mut().insert(SignedIn(user));
            next.run(request).await
        }
        Ok(Some((_, false))) => failure(
            LibraryErrorCode::NotFound,
            "No library is available to this account",
        )
        .into_response(),
        Ok(None) => {
            let mut response = signed_out().into_response();
            if had_cookie {
                clear_cookie(&state.access, &mut response);
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
    Ok(Json(SessionInfo {
        user: SessionUser {
            id: user.id,
            username: user.username,
        },
        library_access,
    }))
}

#[utoipa::path(post, path = "/api/session", operation_id = "signIn",
    request_body = SignInRequest,
    description = "Sign in with a Citadel username and password. Sets an HttpOnly session cookie.",
    responses((status = 200, body = SessionInfo), (status = 400, body = LibraryError),
        (status = 401, body = LibraryError), (status = 403, body = LibraryError),
        (status = 429, body = LibraryError), (status = 503, body = LibraryError), (status = 500, body = LibraryError)))]
async fn sign_in(
    State(state): State<ApiState>,
    method: Method,
    headers: HeaderMap,
    input: Result<Json<SignInRequest>, JsonRejection>,
) -> Response {
    if cross_origin(&state.access, &method, &headers) {
        return cross_origin_refused();
    }
    let Ok(Json(input)) = input else {
        return ApiFailure::from(LibraryError::invalid("Invalid sign-in JSON")).into_response();
    };
    if state
        .access
        .backoff
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .refused(Instant::now())
    {
        let mut response =
            failure(LibraryErrorCode::RateLimited, "Too many sign-in attempts").into_response();
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("2"));
        return response;
    }
    let library_id = state.access.library_id.clone();
    let result = blocking(&state, move |accounts| {
        let Some(user) = accounts.verify_password(&input.username, &input.password)? else {
            return Ok(None);
        };
        let token = accounts.create_session(&user.id)?;
        let access = accounts.can_access(&user.id, &library_id)?;
        Ok(Some((user, access, token)))
    })
    .await;
    let result = match result {
        Ok(result) => result,
        Err(error) => return error.into_response(),
    };
    state
        .access
        .backoff
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .note(result.is_some(), Instant::now());
    let Some((user, library_access, token)) = result else {
        return failure(
            LibraryErrorCode::Unauthorized,
            "Incorrect username or password",
        )
        .into_response();
    };
    let mut response = Json(SessionInfo {
        user: SessionUser {
            id: user.id,
            username: user.username,
        },
        library_access,
    })
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        state.access.public_url.cookie(&token, SESSION_TTL_SECONDS),
    );
    response
}

#[utoipa::path(delete, path = "/api/session", operation_id = "signOut",
    description = "End this browser's session and clear its cookie.",
    responses((status = 204), (status = 403, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)))]
async fn sign_out(State(state): State<ApiState>, method: Method, headers: HeaderMap) -> Response {
    if cross_origin(&state.access, &method, &headers) {
        return cross_origin_refused();
    }
    if let Some(token) = session_token(&headers) {
        if let Err(error) = blocking(&state, move |accounts| accounts.delete_session(&token)).await
        {
            return error.into_response();
        }
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    clear_cookie(&state.access, &mut response);
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
        assert!(https
            .cookie("token", 60)
            .to_str()
            .unwrap()
            .ends_with("; Secure"));
        assert_eq!(
            PublicUrl::parse("https://books.example.com:443").unwrap(),
            https
        );
        let http = PublicUrl::parse("http://127.0.0.1:8081").unwrap();
        assert_eq!(http.origin, "http://127.0.0.1:8081");
        assert!(!http
            .cookie("token", 60)
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
    fn sign_in_failures_back_off() {
        let now = Instant::now();
        let mut backoff = Backoff::default();
        backoff.note(false, now);
        backoff.note(false, now);
        assert!(!backoff.refused(now));
        backoff.note(false, now);
        assert!(backoff.refused(now));
        assert!(!backoff.refused(now + Duration::from_secs(3)));
        backoff.note(true, now);
        assert!(!backoff.refused(now));
    }
}
