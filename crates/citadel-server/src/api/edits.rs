//! Editing books and authors. Each write goes through `LibraryService`, which
//! checks the book or author exists before changing anything.
use axum::{
    extract::{rejection::JsonRejection, Extension, Path, State},
    http::StatusCode,
    Json,
};
use citadel_core::{
    contracts::{custom_columns::CustomValueDto, AuthorUpdate, BookUpdate, NewAuthor},
    error::LibraryError,
    store::LibraryPermission,
    LibraryAuthor,
};
use serde::Deserialize;

use super::{session, write, ApiFailure, ApiState};

fn body<T>(request: Result<Json<T>, JsonRejection>, what: &str) -> Result<T, ApiFailure> {
    request
        .map(|Json(body)| body)
        .map_err(|_| LibraryError::invalid(format!("Invalid {what} JSON")).into())
}

#[utoipa::path(patch, path = "/api/books/{book_id}", operation_id = "updateBook",
    params(("book_id" = String, Path, description = "Library book ID")),
    request_body = BookUpdate,
    description = "Change a book's metadata. Fields left out (or null) stay as they are; `timestamp` is ignored. The title can't be blank, and every ID in `author_id_list` must be an existing author.",
    responses((status = 204), (status = 400, body = LibraryError), (status = 401, body = LibraryError),
        (status = 403, body = LibraryError), (status = 404, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn update_book(
    State(state): State<ApiState>,
    Extension(session::SignedIn(user)): Extension<session::SignedIn>,
    Extension(permission): Extension<LibraryPermission>,
    Path(id): Path<String>,
    request: Result<Json<BookUpdate>, JsonRejection>,
) -> Result<StatusCode, ApiFailure> {
    let updates = body(request, "book update")?;
    write(state, permission, move |service| {
        service.update_book(&user.actor(), &id, updates)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct UpsertIdentifier {
    label: String,
    value: String,
    /// Replace this identifier of the book; omit to add a new one.
    #[serde(default)]
    existing_id: Option<i32>,
}

#[utoipa::path(post, path = "/api/books/{book_id}/identifiers", operation_id = "upsertBookIdentifier",
    params(("book_id" = String, Path, description = "Library book ID")),
    request_body = UpsertIdentifier,
    description = "Add an identifier (such as an ISBN) to a book, or replace one of its identifiers. A book has at most one identifier of each type (ignoring case), so adding a second is refused with 409.",
    responses((status = 204), (status = 400, body = LibraryError), (status = 401, body = LibraryError),
        (status = 403, body = LibraryError), (status = 404, body = LibraryError),
        (status = 409, body = LibraryError), (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn upsert_identifier(
    State(state): State<ApiState>,
    Extension(session::SignedIn(user)): Extension<session::SignedIn>,
    Extension(permission): Extension<LibraryPermission>,
    Path(id): Path<String>,
    request: Result<Json<UpsertIdentifier>, JsonRejection>,
) -> Result<StatusCode, ApiFailure> {
    let request = body(request, "identifier")?;
    write(state, permission, move |service| {
        service.upsert_identifier(
            &user.actor(),
            &id,
            request.label,
            request.value,
            request.existing_id,
        )
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path = "/api/books/{book_id}/identifiers/{identifier_id}", operation_id = "deleteBookIdentifier",
    params(("book_id" = String, Path, description = "Library book ID"),
        ("identifier_id" = i32, Path, description = "One of the book's identifier IDs")),
    responses((status = 204), (status = 400, body = LibraryError), (status = 401, body = LibraryError),
        (status = 403, body = LibraryError), (status = 404, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn delete_identifier(
    State(state): State<ApiState>,
    Extension(session::SignedIn(user)): Extension<session::SignedIn>,
    Extension(permission): Extension<LibraryPermission>,
    Path((id, identifier_id)): Path<(String, i32)>,
) -> Result<StatusCode, ApiFailure> {
    write(state, permission, move |service| {
        service.delete_identifier(&user.actor(), &id, identifier_id)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct SetCustomValue {
    /// The new value, or null to clear it. Required, so a body that leaves it
    /// out isn't taken as a request to clear the value.
    #[serde(deserialize_with = "present")]
    #[schema(required = true)]
    value: Option<CustomValueDto>,
}

fn present<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<CustomValueDto>, D::Error> {
    Option::deserialize(deserializer)
}

#[utoipa::path(put, path = "/api/books/{book_id}/custom-values/{column_id}", operation_id = "setCustomValue",
    params(("book_id" = String, Path, description = "Library book ID"),
        ("column_id" = i32, Path, description = "A custom column ID from /api/custom-columns")),
    request_body = SetCustomValue,
    responses((status = 204), (status = 400, body = LibraryError), (status = 401, body = LibraryError),
        (status = 403, body = LibraryError), (status = 404, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn set_custom_value(
    State(state): State<ApiState>,
    Extension(session::SignedIn(user)): Extension<session::SignedIn>,
    Extension(permission): Extension<LibraryPermission>,
    Path((id, column_id)): Path<(String, i32)>,
    request: Result<Json<SetCustomValue>, JsonRejection>,
) -> Result<StatusCode, ApiFailure> {
    let request = body(request, "custom value")?;
    write(state, permission, move |service| {
        service.set_custom_value(&user.actor(), &id, column_id, request.value)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct AddGenres {
    genres: Vec<String>,
}

#[utoipa::path(post, path = "/api/books/{book_id}/genres", operation_id = "addBookGenres",
    params(("book_id" = String, Path, description = "Library book ID")),
    request_body = AddGenres,
    description = "Add genres to the ones a book already has. The library's genre column is created the first time any book gets one.",
    responses((status = 204), (status = 400, body = LibraryError), (status = 401, body = LibraryError),
        (status = 403, body = LibraryError), (status = 404, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn add_genres(
    State(state): State<ApiState>,
    Extension(session::SignedIn(user)): Extension<session::SignedIn>,
    Extension(permission): Extension<LibraryPermission>,
    Path(id): Path<String>,
    request: Result<Json<AddGenres>, JsonRejection>,
) -> Result<StatusCode, ApiFailure> {
    let request = body(request, "genres")?;
    write(state, permission, move |service| {
        service.add_genres(&user.actor(), &id, request.genres)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateAuthors {
    authors: Vec<NewAuthor>,
}

#[utoipa::path(post, path = "/api/authors", operation_id = "createAuthors",
    request_body = CreateAuthors,
    description = "Add authors. A name already in the library (ignoring case) isn't added again; its existing author comes back instead. Names can't be blank.",
    responses((status = 200, body = Vec<LibraryAuthor>), (status = 400, body = LibraryError),
        (status = 401, body = LibraryError), (status = 403, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn create_authors(
    State(state): State<ApiState>,
    Extension(session::SignedIn(user)): Extension<session::SignedIn>,
    Extension(permission): Extension<LibraryPermission>,
    request: Result<Json<CreateAuthors>, JsonRejection>,
) -> Result<Json<Vec<LibraryAuthor>>, ApiFailure> {
    let request = body(request, "new authors")?;
    Ok(Json(
        write(state, permission, move |service| {
            service.create_authors(&user.actor(), request.authors)
        })
        .await?,
    ))
}

#[utoipa::path(patch, path = "/api/authors/{author_id}", operation_id = "updateAuthor",
    params(("author_id" = String, Path, description = "Library author ID")),
    request_body = AuthorUpdate,
    description = "Change an author's name, sortable name or link. Fields left out (or null) stay as they are. A name can't be blank or another author's (409).",
    responses((status = 204), (status = 400, body = LibraryError), (status = 401, body = LibraryError),
        (status = 403, body = LibraryError), (status = 404, body = LibraryError), (status = 409, body = LibraryError),
        (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn update_author(
    State(state): State<ApiState>,
    Extension(session::SignedIn(user)): Extension<session::SignedIn>,
    Extension(permission): Extension<LibraryPermission>,
    Path(id): Path<String>,
    request: Result<Json<AuthorUpdate>, JsonRejection>,
) -> Result<StatusCode, ApiFailure> {
    let updates = body(request, "author update")?;
    write(state, permission, move |service| {
        service.update_author(&user.actor(), &id, updates)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
