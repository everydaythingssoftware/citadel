//! The server itself: which build is running, and whether a newer release
//! is out (administrators only).
use axum::{
    extract::{Extension, Request, State},
    http::{HeaderMap, HeaderValue},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use citadel_core::error::LibraryError;
use serde::Serialize;
use utoipa_axum::{router::OpenApiRouter, routes};

use super::{
    addresses::{RequestOrigin, Standing},
    session::{current_user, signed_out},
    ApiState,
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
    OpenApiRouter::new().routes(routes!(addresses))
}
