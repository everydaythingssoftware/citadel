//! The server itself: which build is running, and whether a newer release
//! is out (administrators only).
use axum::{
    extract::{rejection::JsonRejection, Extension, Request, State},
    http::{HeaderMap, HeaderValue},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use citadel_core::error::{LibraryError, LibraryErrorCode};
use citadel_opds::client::IpRange;
use serde::{Deserialize, Serialize};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::{
    addresses::{RequestOrigin, Standing},
    session::{blocking, current_user, signed_out},
    ApiFailure, ApiState,
};
use crate::{release, updates::UpdateStatus};

/// Names the build on every response, so a page loaded from an older build
/// can tell the server changed under it.
pub const BUILD_HEADER: &str = "citadel-build";

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct ServerVersion {
    /// The release version, such as `0.8.0`.
    version: String,
    /// The commit the server was built from, abbreviated.
    commit: String,
    /// Version and commit together; also sent as the `Citadel-Build` header.
    build: String,
}

#[utoipa::path(get, path = "/api/version", operation_id = "getServerVersion",
    description = "Which Citadel this server is. Public.",
    responses((status = 200, body = ServerVersion)))]
async fn version() -> Json<ServerVersion> {
    version_json()
}

pub(super) fn version_json() -> Json<ServerVersion> {
    Json(ServerVersion {
        version: release::VERSION.into(),
        commit: release::COMMIT.into(),
        build: release::BUILD.into(),
    })
}

#[utoipa::path(get, path = "/api/server/update", operation_id = "getServerUpdate",
    description = "Which Citadel this server runs, and for administrators whether a newer release is out. The server asks GitHub once a day.",
    responses((status = 200, body = UpdateStatus), (status = 401, body = LibraryError)),
    security(("session" = [])))]
async fn update(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    match current_user(&state, &headers).await {
        Ok(Some((user, _))) => Json(state.updates.status(user.is_administrator())).into_response(),
        Ok(None) => signed_out().into_response(),
        Err(error) => error.into_response(),
    }
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct ServerAddress {
    /// An origin, such as `https://books.example.com`.
    url: String,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct ServerAddresses {
    /// The configured public URLs. Empty means Citadel answers at any
    /// address.
    addresses: Vec<ServerAddress>,
    /// The config file that sets them, when the server runs from one; null
    /// when its settings come from environment variables
    /// (`CITADEL_PUBLIC_URLS`).
    #[schema(required = true)]
    config_file: Option<String>,
    /// This machine's own address on the listener's port, such as
    /// `http://localhost:8081`. It always works, whatever the list says.
    #[schema(required = true)]
    always_included: Option<String>,
    /// The address this request came in on.
    #[schema(required = true)]
    current: Option<String>,
    /// `current` is in the list (not merely allowed as this machine's).
    current_listed: bool,
}

fn listing(state: &ApiState, origin: Option<&RequestOrigin>) -> ServerAddresses {
    let addresses = &state.access.addresses;
    ServerAddresses {
        addresses: addresses
            .all()
            .into_iter()
            .map(|url| ServerAddress {
                url: url.origin().to_string(),
            })
            .collect(),
        config_file: addresses.config_file().map(str::to_string),
        always_included: addresses.local().map(|url| url.origin().to_string()),
        current: origin.map(|RequestOrigin(url)| url.origin().to_string()),
        current_listed: origin
            .is_some_and(|RequestOrigin(url)| addresses.standing(url) == Standing::Listed),
    }
}

#[utoipa::path(get, path = "/api/server/addresses", operation_id = "getServerAddresses",
    description = "The public URLs browsers may reach Citadel at, where they are set, and the address this request used. Read-only: only the server's configuration sets them, and with none Citadel answers at any address. Administrators only.",
    responses((status = 200, body = ServerAddresses), (status = 401, body = LibraryError), (status = 403, body = LibraryError)),
    security(("session" = [])))]
async fn addresses(
    State(state): State<ApiState>,
    origin: Option<Extension<RequestOrigin>>,
) -> Json<ServerAddresses> {
    Json(listing(
        &state,
        origin.as_ref().map(|Extension(origin)| origin),
    ))
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct UntrustedProxy {
    /// The peer's address, such as `172.18.0.5`.
    address: String,
    /// The forwarding headers it sent, lowercase.
    headers: Vec<String>,
    last_seen: DateTime<Utc>,
    /// Requests seen from it since the server started (or since it was
    /// last forgotten).
    requests: u64,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct ServerProxies {
    /// `trustedProxies` from the server's configuration. Null when unset:
    /// then client addresses are believed from this machine only, and the
    /// address the browser used from private networks too.
    #[schema(required = true)]
    configured: Option<Vec<String>>,
    /// Ranges an administrator trusted here, on top of the configuration.
    trusted: Vec<String>,
    /// The header a trusted proxy names the client in.
    forwarded_header: String,
    /// Peers on private networks that sent forwarding headers but aren't
    /// trusted, so their headers are ignored; most recent first.
    untrusted: Vec<UntrustedProxy>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProxyRange {
    /// An address, such as `172.18.0.5`, or a range, such as `172.18.0.0/16`.
    range: String,
}

fn proxies_listing(state: &ApiState) -> ServerProxies {
    let clients = state.access.addresses.clients();
    let trust = clients.trust();
    ServerProxies {
        configured: trust
            .configured()
            .map(|ranges| ranges.iter().map(ToString::to_string).collect()),
        trusted: trust.stored().iter().map(ToString::to_string).collect(),
        forwarded_header: clients.header().name().into(),
        untrusted: clients
            .untrusted_forwarders()
            .list()
            .into_iter()
            .map(|forwarder| UntrustedProxy {
                address: forwarder.address.to_string(),
                headers: forwarder.headers,
                last_seen: forwarder.last_seen.into(),
                requests: forwarder.requests,
            })
            .collect(),
    }
}

fn parse_range(request: Result<Json<ProxyRange>, JsonRejection>) -> Result<IpRange, ApiFailure> {
    let Json(request) = request.map_err(|_| LibraryError::invalid("Invalid proxy JSON"))?;
    IpRange::parse(&request.range).map_err(|error| LibraryError::invalid(error).into())
}

/// One edit to the stored ranges at a time, so two can't lose each other.
static PROXY_EDITS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn store_ranges(state: &ApiState, ranges: Vec<IpRange>) -> Result<(), ApiFailure> {
    let saved: Vec<String> = ranges.iter().map(ToString::to_string).collect();
    blocking(state, move |accounts| accounts.set_trusted_proxies(&saved)).await?;
    state.access.addresses.clients().trust().set_stored(ranges);
    Ok(())
}

#[utoipa::path(get, path = "/api/server/proxies", operation_id = "getServerProxies",
    description = "Which proxies Citadel believes about client addresses and the address the browser used, and which private-network peers sent forwarding headers without being trusted. Administrators only.",
    responses((status = 200, body = ServerProxies), (status = 401, body = LibraryError), (status = 403, body = LibraryError)),
    security(("session" = [])))]
async fn proxies(State(state): State<ApiState>) -> Json<ServerProxies> {
    Json(proxies_listing(&state))
}

#[utoipa::path(post, path = "/api/server/proxies", operation_id = "trustServerProxy",
    request_body = ProxyRange,
    description = "Trust a reverse proxy's forwarding headers, on top of the configuration's trustedProxies. Saved in citadel.db; the configuration file is never written. Administrators only.",
    responses((status = 200, body = ServerProxies), (status = 400, body = LibraryError), (status = 401, body = LibraryError),
        (status = 403, body = LibraryError), (status = 503, body = LibraryError)),
    security(("session" = [])))]
async fn trust_proxy(
    State(state): State<ApiState>,
    request: Result<Json<ProxyRange>, JsonRejection>,
) -> Result<Json<ServerProxies>, ApiFailure> {
    let range = parse_range(request)?;
    let _edit = PROXY_EDITS.lock().await;
    let mut ranges = state.access.addresses.clients().trust().stored();
    if !ranges.contains(&range) {
        ranges.push(range);
        store_ranges(&state, ranges).await?;
    }
    state
        .access
        .addresses
        .clients()
        .untrusted_forwarders()
        .forget(&range);
    Ok(Json(proxies_listing(&state)))
}

#[utoipa::path(delete, path = "/api/server/proxies", operation_id = "forgetServerProxy",
    request_body = ProxyRange,
    description = "Stop trusting a range trusted here, and stop offering the untrusted peers in it. Ranges from the configuration can only be changed there (409). Administrators only.",
    responses((status = 200, body = ServerProxies), (status = 400, body = LibraryError), (status = 401, body = LibraryError),
        (status = 403, body = LibraryError), (status = 409, body = LibraryError), (status = 503, body = LibraryError)),
    security(("session" = [])))]
async fn forget_proxy(
    State(state): State<ApiState>,
    request: Result<Json<ProxyRange>, JsonRejection>,
) -> Result<Json<ServerProxies>, ApiFailure> {
    let range = parse_range(request)?;
    let clients = state.access.addresses.clients();
    if clients
        .trust()
        .configured()
        .is_some_and(|configured| configured.contains(&range))
    {
        return Err(LibraryError::new(
            LibraryErrorCode::Conflict,
            format!("{range} is in the server's trustedProxies; change it there"),
        )
        .into());
    }
    let _edit = PROXY_EDITS.lock().await;
    let mut ranges = clients.trust().stored();
    if ranges.contains(&range) {
        ranges.retain(|stored| *stored != range);
        store_ranges(&state, ranges).await?;
    }
    clients.untrusted_forwarders().dismiss(&range);
    Ok(Json(proxies_listing(&state)))
}

pub(super) async fn name_the_build(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(BUILD_HEADER, HeaderValue::from_static(release::BUILD));
    response
}

pub(super) fn public_routes() -> OpenApiRouter<ApiState> {
    OpenApiRouter::new()
        .routes(routes!(version))
        .routes(routes!(update))
}

pub(super) fn administrator_routes() -> OpenApiRouter<ApiState> {
    OpenApiRouter::new()
        .routes(routes!(addresses))
        .routes(routes!(proxies, trust_proxy, forget_proxy))
}
