//! First-run setup: creating the administrator with the code the server
//! printed, and the administrator's choice of library. Library routes are
//! behind `require_administrator`; readers never see the server's folders.
use axum::{
    extract::{rejection::JsonRejection, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Extension, Json,
};
use citadel_core::{
    error::{LibraryError, LibraryErrorCode},
    password::setup_code_matches,
    store::{Role, SESSION_TTL_SECONDS},
};
use serde::{Deserialize, Serialize};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::{
    session::{self, blocking, current_user, SessionInfo, SignedIn},
    ApiFailure, ApiState,
};
use crate::served::{
    DirectoryListing, FoundLibraries, Inspection, SchemaUpgradeInfo, ServedLibrary,
    ServedLibraryInfo,
};

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetupStatus {
    /// False until the first administrator is created with the setup code
    /// the server printed when it started.
    administrator_exists: bool,
    /// A library has been chosen (it may still be unreachable).
    library_configured: bool,
    /// The chosen library is open and can be browsed.
    library_available: bool,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CreateAdministrator {
    /// The code from the server's console, such as `K7QD-M2XV-H9RW`.
    setup_code: String,
    username: String,
    password: String,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct LibrarySetup {
    #[schema(required = true)]
    library: Option<ServedLibraryInfo>,
    /// Where the directory browser starts.
    browse_root: String,
    /// Libraries in the folders mounted for them, and empty mounts a new one
    /// could start in.
    found: FoundLibraries,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InspectPath {
    /// An absolute path on the server.
    path: String,
}

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
#[serde(rename_all = "camelCase")]
pub(super) struct ListDirectory {
    /// An absolute path on the server; the browse root when omitted.
    path: Option<String>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) enum SetupMode {
    /// Make a new library in an empty or missing folder.
    Create,
    /// Serve the Calibre library already in the folder.
    Adopt,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ChooseLibrary {
    mode: SetupMode,
    path: String,
    /// Display name; the folder's name when omitted.
    name: Option<String>,
    /// Adopt only: bring an older library to Calibre's current format first.
    /// A backup is kept beside its database.
    #[serde(default)]
    upgrade: bool,
    /// Adopt only: serve the library without changing it, for libraries
    /// still managed in Calibre elsewhere. Adding, editing and upgrading are
    /// off.
    #[serde(default)]
    read_only: bool,
}

fn forbidden(message: &str) -> Response {
    let error = LibraryError {
        code: LibraryErrorCode::Unauthorized,
        message: message.into(),
    };
    (StatusCode::FORBIDDEN, Json(error)).into_response()
}

/// Requires a signed-in administrator. Readers get 403, so the routes behind
/// this never leak the server's folders through a 404 guessing game either.
pub(super) async fn require_administrator(
    State(state): State<ApiState>,
    mut request: Request,
    next: Next,
) -> Response {
    if session::cross_origin(&state.access, request.method(), request.headers()) {
        return session::cross_origin_refused();
    }
    match current_user(&state, request.headers()).await {
        Ok(Some((user, _))) if user.is_administrator() => {
            request.extensions_mut().insert(SignedIn(user));
            next.run(request).await
        }
        Ok(Some(_)) => forbidden("Administrators only"),
        Ok(None) => session::signed_out().into_response(),
        Err(error) => error.into_response(),
    }
}

async fn served<T: Send + 'static>(
    state: &ApiState,
    operation: impl FnOnce(&ServedLibrary) -> Result<T, LibraryError> + Send + 'static,
) -> Result<T, ApiFailure> {
    let permit = state
        .work
        .clone()
        .try_acquire_owned()
        .map_err(|_| LibraryError::unavailable())?;
    let served = state.access.served.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        operation(&served)
    })
    .await
    .map_err(|_| LibraryError::unavailable())?
    .map_err(Into::into)
}

#[utoipa::path(get, path = "/api/setup", operation_id = "getSetupStatus",
    description = "Whether an administrator exists and a library is set up. Public, so the sign-in page knows which form to show.",
    responses((status = 200, body = SetupStatus), (status = 503, body = LibraryError), (status = 500, body = LibraryError)))]
async fn status(State(state): State<ApiState>) -> Result<Json<SetupStatus>, ApiFailure> {
    let administrator_exists = blocking(&state, |accounts| accounts.administrator_exists()).await?;
    let served = &state.access.served;
    Ok(Json(SetupStatus {
        administrator_exists,
        library_configured: served.is_configured(),
        library_available: served.info().is_some_and(|info| info.available),
    }))
}

#[utoipa::path(post, path = "/api/setup/administrator", operation_id = "createAdministrator",
    request_body = CreateAdministrator,
    description = "Create the first administrator with the setup code the server printed, and sign them in. Refused once an administrator exists.",
    responses((status = 200, body = SessionInfo), (status = 400, body = LibraryError),
        (status = 401, body = LibraryError), (status = 403, body = LibraryError), (status = 409, body = LibraryError),
        (status = 429, body = LibraryError), (status = 503, body = LibraryError), (status = 500, body = LibraryError)))]
async fn create_administrator(
    State(state): State<ApiState>,
    method: Method,
    headers: HeaderMap,
    input: Result<Json<CreateAdministrator>, JsonRejection>,
) -> Response {
    if session::cross_origin(&state.access, &method, &headers) {
        return session::cross_origin_refused();
    }
    let Ok(Json(input)) = input else {
        return ApiFailure::from(LibraryError::invalid("Invalid administrator JSON"))
            .into_response();
    };
    if state.access.backoff_refused() {
        let mut response = ApiFailure::from(LibraryError::new(
            LibraryErrorCode::RateLimited,
            "Too many attempts",
        ))
        .into_response();
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("2"));
        return response;
    }
    let exists = match blocking(&state, |accounts| accounts.administrator_exists()).await {
        Ok(exists) => exists,
        Err(error) => return error.into_response(),
    };
    let expected = state.access.setup_code();
    let (Some(expected), false) = (expected, exists) else {
        return ApiFailure::from(LibraryError::new(
            LibraryErrorCode::Conflict,
            "An administrator already exists; sign in instead",
        ))
        .into_response();
    };
    let matches = setup_code_matches(&expected, &input.setup_code);
    state.access.note_attempt(matches);
    if !matches {
        return ApiFailure::from(LibraryError::new(
            LibraryErrorCode::Unauthorized,
            "Incorrect setup code",
        ))
        .into_response();
    }
    let created = blocking(&state, move |accounts| {
        let user = accounts.create_user_with_role(
            &input.username,
            &input.password,
            Role::Administrator,
        )?;
        let token = accounts.create_session(&user.id)?;
        Ok((user, token))
    })
    .await;
    let (user, token) = match created {
        Ok(created) => created,
        Err(error) => return error.into_response(),
    };
    state.access.consume_setup_code();
    let library_access = false;
    let mut response = Json(SessionInfo::new(&user, library_access)).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        state.access.public_url.cookie(&token, SESSION_TTL_SECONDS),
    );
    response
}

#[utoipa::path(get, path = "/api/setup/library", operation_id = "getLibrarySetup",
    description = "The served library, if one was chosen, and where the directory browser starts. Administrators only.",
    responses((status = 200, body = LibrarySetup), (status = 401, body = LibraryError), (status = 403, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)), security(("session" = [])))]
async fn library_setup(State(state): State<ApiState>) -> Result<Json<LibrarySetup>, ApiFailure> {
    Ok(Json(
        served(&state, |served| {
            Ok(LibrarySetup {
                library: served.info(),
                browse_root: served.browse_root().to_string_lossy().into_owned(),
                found: served.found(),
            })
        })
        .await?,
    ))
}

#[utoipa::path(post, path = "/api/setup/library/inspect", operation_id = "inspectPath",
    request_body = InspectPath,
    description = "What is at an absolute server path: a library (with its size and schema version), an empty folder, something else, or a reason it can't be used. Administrators only.",
    responses((status = 200, body = Inspection), (status = 400, body = LibraryError), (status = 401, body = LibraryError),
        (status = 403, body = LibraryError), (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
async fn inspect(
    State(state): State<ApiState>,
    input: Result<Json<InspectPath>, JsonRejection>,
) -> Result<Json<Inspection>, ApiFailure> {
    let Json(input) = input.map_err(|_| LibraryError::invalid("Invalid inspect JSON"))?;
    Ok(Json(
        served(&state, move |served| Ok(served.inspect(&input.path))).await?,
    ))
}

#[utoipa::path(get, path = "/api/setup/directories", operation_id = "listDirectories",
    params(ListDirectory),
    description = "Subfolders of a server folder (dotfolders hidden), one level at a time, for choosing a library location. Administrators only.",
    responses((status = 200, body = DirectoryListing), (status = 400, body = LibraryError), (status = 401, body = LibraryError),
        (status = 403, body = LibraryError), (status = 404, body = LibraryError), (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
async fn directories(
    State(state): State<ApiState>,
    Query(query): Query<ListDirectory>,
) -> Result<Json<DirectoryListing>, ApiFailure> {
    Ok(Json(
        served(&state, move |served| {
            served.list_directory(query.path.as_deref())
        })
        .await?,
    ))
}

#[utoipa::path(post, path = "/api/setup/library", operation_id = "chooseLibrary",
    request_body = ChooseLibrary,
    description = "Create a new library or adopt an existing one at a server path, register it, grant the administrator access and start serving it. 409 while a library is already served. Administrators only.",
    responses((status = 200, body = ServedLibraryInfo), (status = 400, body = LibraryError), (status = 401, body = LibraryError),
        (status = 403, body = LibraryError), (status = 404, body = LibraryError), (status = 409, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
async fn choose_library(
    State(state): State<ApiState>,
    Extension(SignedIn(user)): Extension<SignedIn>,
    input: Result<Json<ChooseLibrary>, JsonRejection>,
) -> Result<Json<ServedLibraryInfo>, ApiFailure> {
    let Json(input) = input.map_err(|_| LibraryError::invalid("Invalid library setup JSON"))?;
    Ok(Json(
        served(&state, move |served| match input.mode {
            SetupMode::Create => served.create(&input.path, input.name.as_deref(), &user),
            SetupMode::Adopt => served.adopt(
                &input.path,
                input.name.as_deref(),
                input.upgrade,
                input.read_only,
                &user,
            ),
        })
        .await?,
    ))
}

#[utoipa::path(post, path = "/api/setup/library/reopen", operation_id = "reopenLibrary",
    description = "Try the registered library's folder again after it was unreachable. Administrators only.",
    responses((status = 200, body = ServedLibraryInfo), (status = 401, body = LibraryError), (status = 403, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)), security(("session" = [])))]
async fn reopen(State(state): State<ApiState>) -> Result<Json<ServedLibraryInfo>, ApiFailure> {
    Ok(Json(served(&state, |served| served.reopen()).await?))
}

#[utoipa::path(post, path = "/api/setup/library/upgrade", operation_id = "upgradeLibrary",
    description = "Bring the served library to Calibre's current database format, after backing its database up beside it. Administrators only.",
    responses((status = 200, body = SchemaUpgradeInfo), (status = 401, body = LibraryError), (status = 403, body = LibraryError),
        (status = 409, body = LibraryError), (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
async fn upgrade(State(state): State<ApiState>) -> Result<Json<SchemaUpgradeInfo>, ApiFailure> {
    Ok(Json(served(&state, |served| served.upgrade()).await?))
}

/// Public: the status and the administrator bootstrap.
pub(super) fn public_routes() -> OpenApiRouter<ApiState> {
    OpenApiRouter::new()
        .routes(routes!(status))
        .routes(routes!(create_administrator))
}

/// Behind [`require_administrator`].
pub(super) fn administrator_routes() -> OpenApiRouter<ApiState> {
    OpenApiRouter::new()
        .routes(routes!(library_setup, choose_library))
        .routes(routes!(inspect))
        .routes(routes!(directories))
        .routes(routes!(reopen))
        .routes(routes!(upgrade))
}
