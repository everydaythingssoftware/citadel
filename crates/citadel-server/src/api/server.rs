//! The server itself: which build is running, and whether a newer release
//! is out (administrators only).
use axum::{
    extract::{Request, State},
    http::{HeaderMap, HeaderValue},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use citadel_core::error::LibraryError;
use serde::Serialize;
use utoipa_axum::{router::OpenApiRouter, routes};

use super::{
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
}
