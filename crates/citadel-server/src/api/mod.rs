//! Read-only JSON API. Contracts and application behavior live in citadel-core;
//! browsers authenticate with a Citadel session cookie (see `session`).
use std::{net::SocketAddr, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    extract::{rejection::JsonRejection, Path, Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json, Router,
};
use citadel_core::{
    contracts::{LibraryBookPage, LibraryBookQuery},
    error::{LibraryError, LibraryErrorCode},
    library::LibraryService,
    HttpUrlBuilder, LibraryBook,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use utoipa::openapi::{
    security::{ApiKey, ApiKeyValue, SecurityScheme},
    OpenApi,
};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::CalibreCatalogSource;
use citadel_core::store::CitadelStore;

mod session;
mod thumbnails;
pub(crate) mod web;

pub use session::{PublicUrl, SESSION_COOKIE};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiConfig {
    pub listen: SocketAddr,
    pub public_url: String,
    pub web_directory: Option<std::path::PathBuf>,
}

/// Who may use the API: the accounts database, the Citadel ID of the library
/// this server serves, and the origin browsers sign in from.
pub struct ApiAccess {
    pub accounts: Arc<CitadelStore>,
    pub library_id: String,
    pub public_url: PublicUrl,
}

#[derive(Clone)]
struct ApiState {
    source: Arc<CalibreCatalogSource>,
    access: Arc<session::Access>,
    work: Arc<Semaphore>,
    thumbnails: thumbnails::ThumbnailCache,
}

// Keep slots inside blocking tasks so timed-out HTTP requests cannot queue
// unlimited work waiting for the shared SQLite connection.
async fn run<T: Send + 'static>(
    state: ApiState,
    operation: impl FnOnce(&mut LibraryService<'_>) -> Result<T, LibraryError> + Send + 'static,
) -> Result<T, ApiFailure> {
    run_library(state, move |library| {
        operation(&mut LibraryService::new(library, &HttpUrlBuilder::new("")))
    })
    .await
}

async fn run_library<T: Send + 'static>(
    state: ApiState,
    operation: impl FnOnce(&mut libcalibre::Library) -> Result<T, LibraryError> + Send + 'static,
) -> Result<T, ApiFailure> {
    let permit = state
        .work
        .try_acquire_owned()
        .map_err(|_| LibraryError::unavailable())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut library = state
            .source
            .library
            .lock()
            .map_err(|_| LibraryError::unavailable())?;
        operation(&mut library)
    })
    .await
    .map_err(|_| LibraryError::unavailable())?
    .map_err(Into::into)
}

pub struct ApiFailure(LibraryError);
impl From<LibraryError> for ApiFailure {
    fn from(error: LibraryError) -> Self {
        Self(error)
    }
}
impl IntoResponse for ApiFailure {
    fn into_response(mut self) -> Response {
        let status = match self.0.code {
            LibraryErrorCode::InvalidArgument => StatusCode::BAD_REQUEST,
            LibraryErrorCode::Unauthorized => StatusCode::UNAUTHORIZED,
            LibraryErrorCode::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            LibraryErrorCode::NotFound => StatusCode::NOT_FOUND,
            LibraryErrorCode::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            LibraryErrorCode::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        if self.0.code == LibraryErrorCode::Internal {
            // Database/filesystem diagnostics may include private server paths.
            self.0.message = "Library operation failed".into();
        }
        let mut response = (status, Json(self.0)).into_response();
        if status == StatusCode::SERVICE_UNAVAILABLE {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, "1".parse().unwrap());
        }
        response
    }
}

#[utoipa::path(post, path = "/api/books/query", operation_id = "queryBooks",
    request_body = LibraryBookQuery,
    description = "Query the configured library. HTTP requires an explicit limit between 0 and 200; zero returns only the total. No arbitrary library paths are accepted.",
    responses((status = 200, body = LibraryBookPage), (status = 400, body = LibraryError),
        (status = 401, body = LibraryError), (status = 429, body = LibraryError), (status = 413, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
async fn query_books(
    State(state): State<ApiState>,
    query: Result<Json<LibraryBookQuery>, JsonRejection>,
) -> Result<Json<LibraryBookPage>, ApiFailure> {
    let Json(query) = query.map_err(|_| LibraryError::invalid("Invalid book query JSON"))?;
    if !matches!(query.limit, Some(0..=200)) {
        return Err(
            LibraryError::invalid("HTTP book queries require a limit between 0 and 200").into(),
        );
    }
    Ok(Json(
        run(state, move |service| service.query_books(query)).await?,
    ))
}

#[utoipa::path(get, path = "/api/books/{book_id}", operation_id = "getBook",
    params(("book_id" = String, Path, description = "Library book ID")),
    responses((status = 200, body = LibraryBook), (status = 400, body = LibraryError),
        (status = 401, body = LibraryError), (status = 429, body = LibraryError), (status = 404, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
async fn get_book(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<LibraryBook>, ApiFailure> {
    Ok(Json(
        run(state, move |service| service.get_book(&id)).await?,
    ))
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
struct LibraryDescriptor {
    id: String,
    name: String,
    read_only: bool,
}

#[utoipa::path(get, path = "/api/library", operation_id = "getLibrary",
    responses((status = 200, body = LibraryDescriptor), (status = 401, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)), security(("session" = [])))]
async fn library_descriptor(
    State(state): State<ApiState>,
) -> Result<Json<LibraryDescriptor>, ApiFailure> {
    let id = state.access.library_id.clone();
    run_library(state, |library| Ok(library.library_uuid()?)).await?;
    Ok(Json(LibraryDescriptor {
        id,
        name: "Citadel Library".into(),
        read_only: true,
    }))
}

#[utoipa::path(get, path = "/api/authors", operation_id = "listAuthors",
    responses((status = 200, body = Vec<citadel_core::LibraryAuthor>), (status = 401, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)), security(("session" = [])))]
async fn authors(
    State(state): State<ApiState>,
) -> Result<Json<Vec<citadel_core::LibraryAuthor>>, ApiFailure> {
    Ok(Json(run(state, |service| service.list_authors()).await?))
}

#[utoipa::path(get, path = "/api/series", operation_id = "listSeries",
    responses((status = 200, body = Vec<citadel_core::contracts::LibrarySeries>), (status = 401, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)), security(("session" = [])))]
async fn series(
    State(state): State<ApiState>,
) -> Result<Json<Vec<citadel_core::contracts::LibrarySeries>>, ApiFailure> {
    Ok(Json(run(state, |service| service.list_series()).await?))
}

#[utoipa::path(get, path = "/api/tags", operation_id = "listTags",
    responses((status = 200, body = Vec<citadel_core::contracts::LibraryTag>), (status = 401, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)), security(("session" = [])))]
async fn tags(
    State(state): State<ApiState>,
) -> Result<Json<Vec<citadel_core::contracts::LibraryTag>>, ApiFailure> {
    Ok(Json(run(state, |service| service.list_tags()).await?))
}

#[utoipa::path(get, path = "/api/publishers", operation_id = "listPublishers",
    responses((status = 200, body = Vec<citadel_core::contracts::LibraryPublisher>), (status = 401, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)), security(("session" = [])))]
async fn publishers(
    State(state): State<ApiState>,
) -> Result<Json<Vec<citadel_core::contracts::LibraryPublisher>>, ApiFailure> {
    Ok(Json(run(state, |service| service.list_publishers()).await?))
}

#[utoipa::path(get, path = "/api/custom-columns", operation_id = "listCustomColumns",
    responses((status = 200, body = Vec<citadel_core::contracts::custom_columns::CustomColumnDef>), (status = 401, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)), security(("session" = [])))]
async fn custom_columns(
    State(state): State<ApiState>,
) -> Result<Json<Vec<citadel_core::contracts::custom_columns::CustomColumnDef>>, ApiFailure> {
    Ok(Json(
        run(state, |service| service.list_custom_columns()).await?,
    ))
}

#[utoipa::path(get, path = "/api/books/{book_id}/custom-values", operation_id = "getCustomValues",
    params(("book_id" = String, Path)),
    responses((status = 200, body = Vec<citadel_core::contracts::custom_columns::BookCustomValue>),
        (status = 400, body = LibraryError), (status = 401, body = LibraryError),
        (status = 404, body = LibraryError), (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
async fn custom_values(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<Vec<citadel_core::contracts::custom_columns::BookCustomValue>>, ApiFailure> {
    Ok(Json(
        run(state, move |service| {
            service.get_book(&id)?;
            service.get_custom_values(&id)
        })
        .await?,
    ))
}

fn routes() -> OpenApiRouter<ApiState> {
    OpenApiRouter::new()
        .routes(routes!(query_books))
        .routes(routes!(get_book))
        .routes(routes!(library_descriptor))
        .routes(routes!(authors))
        .routes(routes!(series))
        .routes(routes!(tags))
        .routes(routes!(publishers))
        .routes(routes!(custom_columns))
        .routes(routes!(custom_values))
        .routes(routes!(thumbnails::ensure, thumbnails::list))
        .routes(routes!(thumbnails::image))
}

pub fn openapi() -> OpenApi {
    let (_, mut schema) = routes().merge(session::routes()).split_for_parts();
    // These handlers are mounted from OPDS so byte streaming, range support and
    // containment checks have one implementation across both transports.
    for (path, operation_id, content_type, extra_parameters) in [
        (
            "/api/books/{book_id}/cover",
            "getBookCover",
            "image/jpeg",
            vec![],
        ),
        (
            "/api/books/{book_id}/files/{format}/{filename}",
            "downloadBookFile",
            "application/octet-stream",
            vec!["format", "filename"],
        ),
    ] {
        let mut parameters = vec![
            serde_json::json!({"name":"book_id", "in":"path", "required":true, "schema":{"type":"integer", "format":"int32"}}),
        ];
        parameters.extend(extra_parameters.into_iter().map(|name| serde_json::json!({"name":name, "in":"path", "required":true, "schema":{"type":"string"}})));
        let operation = serde_json::json!({
            "operationId": operation_id,
            "parameters": parameters,
            "security": [{"session":[]}],
            "responses": {
                "200": {"description":"Book asset", "content":{content_type:{"schema":{"type":"string", "format":"binary"}}}},
                "206": {"description":"Partial book asset"},
                "400": {"description":"Invalid request"},
                "401": {"description":"Unauthorized"},
                "404": {"description":"Asset not found"},
                "416": {"description":"Range not satisfiable"},
                "503": {"description":"Library unavailable"}
            }
        });
        let mut head = operation.clone();
        head["operationId"] = serde_json::json!(format!("{operation_id}Head"));
        schema.paths.paths.insert(
            path.into(),
            serde_json::from_value(serde_json::json!({"get":operation,"head":head}))
                .expect("asset OpenAPI paths are valid"),
        );
    }
    schema.info.title = "Citadel library API".into();
    schema.info.version = "1".into();
    schema
        .components
        .as_mut()
        .expect("API has schemas")
        .add_security_scheme(
            "session",
            SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::new(SESSION_COOKIE))),
        );
    schema
}

pub fn router(
    source: Arc<CalibreCatalogSource>,
    service: &citadel_opds::OpdsService,
    access: ApiAccess,
    web_directory: Option<&std::path::Path>,
) -> Router {
    let state = ApiState {
        source: source.clone(),
        access: Arc::new(session::Access::new(
            access.accounts,
            access.library_id,
            access.public_url,
        )),
        work: Arc::new(Semaphore::new(64)),
        thumbnails: Default::default(),
    };
    let (library, _) = routes().split_for_parts();
    let (session, _) = session::routes().split_for_parts();
    let assets = service.book_asset_routes(source, "/api");
    let schema = openapi();
    let library = library
        .with_state(state.clone())
        .merge(assets)
        .route(
            "/api/openapi.json",
            axum::routing::get(move || {
                let schema = schema.clone();
                async move { Json(schema) }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            session::require_session,
        ));
    // The frontend build is public so a signed-out browser can load the
    // sign-in page; everything it reads afterwards goes through the API.
    let router = session.with_state(state).merge(library);
    let router = match web_directory {
        Some(directory) => router.fallback_service(web::router(directory)),
        None => router,
    };
    service
        .limit_http_routes(router.layer(axum::middleware::from_fn(bound_requests)))
        .layer(axum::middleware::from_fn(normalize_errors))
}

const JSON_BODY_BYTES: usize = 1024 * 1024;
const REQUEST_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);

// JSON requests are small: buffer the body (even when chunked) under the
// deadline so slow clients can't hold handlers, then bound the handler too.
// Asset responses only need their headers within the deadline.
async fn bound_requests(request: Request, next: Next) -> Response {
    let (parts, body) = request.into_parts();
    let body = match tokio::time::timeout(REQUEST_DEADLINE, to_bytes(body, JSON_BODY_BYTES)).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        Err(_) => return ApiFailure(LibraryError::unavailable()).into_response(),
    };
    match tokio::time::timeout(
        REQUEST_DEADLINE,
        next.run(Request::from_parts(parts, Body::from(body))),
    )
    .await
    {
        Ok(response) => response,
        Err(_) => ApiFailure(LibraryError::unavailable()).into_response(),
    }
}

// Admission middleware is shared with OPDS, which uses plain text errors.
// Preserve its status and headers while presenting a JSON API error.
async fn normalize_errors(request: Request, next: Next) -> Response {
    let response = next.run(request).await;
    if !response.status().is_client_error() && !response.status().is_server_error() {
        return response;
    }
    if response
        .headers()
        .get(header::CONTENT_TYPE)
        .is_some_and(|value| value == "application/json")
    {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    drop(to_bytes(body, 16 * 1024).await);
    let code = match parts.status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => LibraryErrorCode::Unauthorized,
        StatusCode::NOT_FOUND => LibraryErrorCode::NotFound,
        StatusCode::TOO_MANY_REQUESTS => LibraryErrorCode::RateLimited,
        StatusCode::SERVICE_UNAVAILABLE => LibraryErrorCode::Unavailable,
        status if status.is_client_error() => LibraryErrorCode::InvalidArgument,
        _ => LibraryErrorCode::Internal,
    };
    let error = LibraryError {
        code,
        message: parts
            .status
            .canonical_reason()
            .unwrap_or("Request failed")
            .into(),
    };
    let bytes = serde_json::to_vec(&error).expect("API error is serializable");
    parts.headers.remove(header::CONTENT_LENGTH);
    parts
        .headers
        .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    Response::from_parts(parts, Body::from(bytes))
}

pub(crate) struct RunningApi {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}
impl RunningApi {
    pub async fn wait(&mut self) -> String {
        match (&mut self.task).await {
            Ok(Ok(())) => "JSON API stopped unexpectedly".into(),
            Ok(Err(error)) => format!("JSON API failed: {error}"),
            Err(error) => format!("JSON API task failed: {error}"),
        }
    }

    pub async fn stop(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if tokio::time::timeout(std::time::Duration::from_secs(5), &mut self.task)
            .await
            .is_err()
        {
            self.task.abort();
            let _ = (&mut self.task).await;
        }
    }
}
impl Drop for RunningApi {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(crate) async fn start(config: &ApiConfig, router: Router) -> Result<RunningApi, String> {
    let listener = tokio::net::TcpListener::bind(config.listen)
        .await
        .map_err(|error| format!("could not bind API {}: {error}", config.listen))?;
    let (shutdown, receiver) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = receiver.await;
            })
            .await
    });
    Ok(RunningApi {
        shutdown: Some(shutdown),
        task,
    })
}
