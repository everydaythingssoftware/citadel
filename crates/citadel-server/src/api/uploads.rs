//! Staged book uploads. A browser declares a file, sends it in chunks that
//! stream straight to disk, and gets back the metadata and cover read from
//! it for review. Staged files live in the server's state directory, never
//! inside the library, and expire unless the upload stays active.
use std::{
    collections::HashMap,
    io::Cursor,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    extract::{rejection::JsonRejection, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::NaiveDate;
use citadel_core::error::{LibraryError, LibraryErrorCode};
use futures_util::StreamExt;
use image::ImageReader;
use libcalibre::{book_file, mime_type::MIMETYPE};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use super::{session::SignedIn, thumbnails::resized_jpeg, ApiFailure, ApiState};

const MIB: u64 = 1024 * 1024;
const EXPIRY: Duration = Duration::from_secs(60 * 60);
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);
/// A chunk that sends nothing for this long is abandoned.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_FILE_NAME_CHARS: usize = 255;
const UPLOAD_OFFSET: &str = "upload-offset";

/// `api.uploads` in the server config. Chunks stay well under reverse-proxy
/// body limits so the total size is Citadel's own choice.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct UploadConfig {
    pub max_file_bytes: u64,
    pub chunk_bytes: u64,
    pub max_staged_bytes: u64,
    pub max_uploads_per_user: usize,
}

impl Default for UploadConfig {
    fn default() -> Self {
        Self {
            max_file_bytes: 200 * MIB,
            chunk_bytes: 8 * MIB,
            max_staged_bytes: 2048 * MIB,
            max_uploads_per_user: 5,
        }
    }
}

impl UploadConfig {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !(64 * 1024..=64 * MIB).contains(&self.chunk_bytes) {
            return Err(
                "api.uploads.chunkBytes must be between 65536 (64 KiB) and 67108864 (64 MiB)"
                    .into(),
            );
        }
        if self.max_file_bytes == 0 {
            return Err("api.uploads.maxFileBytes must be at least 1".into());
        }
        if self.max_staged_bytes < self.max_file_bytes {
            return Err("api.uploads.maxStagedBytes must be at least maxFileBytes".into());
        }
        if self.max_uploads_per_user == 0 {
            return Err("api.uploads.maxUploadsPerUser must be at least 1".into());
        }
        Ok(())
    }
}

/// The uploads in progress and the directory holding their files.
pub struct Staging {
    directory: PathBuf,
    config: UploadConfig,
    uploads: Mutex<HashMap<String, Upload>>,
    now: Box<dyn Fn() -> Instant + Send + Sync>,
}

struct Upload {
    user_id: String,
    library_id: String,
    file_name: String,
    extension: String,
    format: MIMETYPE,
    size: u64,
    received: u64,
    last_active: Instant,
    /// A chunk is being written or the upload is being added to the
    /// library; one thing at a time.
    busy: bool,
    book: Option<StagedBook>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadList {
    max_file_bytes: u64,
    chunk_bytes: u64,
    uploads: Vec<StagedUpload>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CreateUpload {
    /// The file's name, which decides its format by extension.
    file_name: String,
    /// The file's total size in bytes.
    size: u64,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct StagedUpload {
    id: String,
    file_name: String,
    size: u64,
    received_bytes: u64,
    /// Present once every byte has arrived and the file has been read.
    book: Option<StagedBook>,
}

/// What the uploaded file says about itself, for the user to review.
#[derive(Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct StagedBook {
    /// The file's format, as its extension (`epub`, `azw3`, …).
    format: String,
    /// The file's own title, or its name when it has none.
    title: String,
    author_names: Vec<String>,
    identifier: Option<String>,
    publisher: Option<String>,
    language: Option<String>,
    tags: Vec<String>,
    publication_date: Option<NaiveDate>,
    cover_url: Option<String>,
}

fn failure(code: LibraryErrorCode, message: impl Into<String>) -> ApiFailure {
    LibraryError::new(code, message).into()
}

fn not_found() -> ApiFailure {
    failure(LibraryErrorCode::NotFound, "Upload not found")
}

impl Staging {
    /// Opens the staging directory, removing anything left by an earlier run:
    /// uploads only live in memory, so leftover files can't be resumed.
    pub fn open(directory: PathBuf, config: UploadConfig) -> Result<Arc<Self>, String> {
        Self::open_with_clock(directory, config, Box::new(Instant::now))
    }

    fn open_with_clock(
        directory: PathBuf,
        config: UploadConfig,
        now: Box<dyn Fn() -> Instant + Send + Sync>,
    ) -> Result<Arc<Self>, String> {
        let describe =
            |error: std::io::Error| format!("could not prepare {}: {error}", directory.display());
        create_private_dir(&directory).map_err(describe)?;
        for entry in std::fs::read_dir(&directory).map_err(describe)? {
            let path = entry.map_err(describe)?.path();
            let removed = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            removed.map_err(describe)?;
        }
        Ok(Arc::new(Self {
            directory,
            config,
            uploads: Mutex::default(),
            now,
        }))
    }

    /// Sweeps expired uploads every minute until the staging area is dropped.
    pub(crate) fn spawn_sweeper(self: &Arc<Self>) {
        let staging = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(SWEEP_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let Some(staging) = Weak::upgrade(&staging) else {
                    break;
                };
                let _ = tokio::task::spawn_blocking(move || staging.sweep()).await;
            }
        });
    }

    /// Removes uploads idle past their expiry, and any file that belongs to
    /// no upload (one whose removal failed earlier).
    fn sweep(&self) {
        let now = (self.now)();
        let live: Vec<String> = {
            let Ok(mut uploads) = self.uploads.lock() else {
                return;
            };
            uploads
                .retain(|_, upload| upload.busy || now.duration_since(upload.last_active) < EXPIRY);
            uploads.keys().cloned().collect()
        };
        let Ok(entries) = std::fs::read_dir(&self.directory) else {
            return;
        };
        for path in entries.flatten().map(|entry| entry.path()) {
            let id = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.split('.').next());
            if !id.is_some_and(|id| live.iter().any(|live| live == id)) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    fn book_path(&self, id: &str, extension: &str) -> PathBuf {
        self.directory.join(format!("{id}.{extension}"))
    }

    fn cover_path(&self, id: &str) -> PathBuf {
        self.directory.join(format!("{id}.cover.jpg"))
    }

    fn remove_files(&self, id: &str, extension: &str) {
        let _ = std::fs::remove_file(self.book_path(id, extension));
        let _ = std::fs::remove_file(self.cover_path(id));
    }

    /// Runs `update` on an upload the user owns, marking it active.
    fn with_upload<T>(
        &self,
        id: &str,
        user: &Owner,
        update: impl FnOnce(&mut Upload) -> Result<T, ApiFailure>,
    ) -> Result<T, ApiFailure> {
        let mut uploads = self
            .uploads
            .lock()
            .map_err(|_| LibraryError::unavailable())?;
        let upload = uploads
            .get_mut(id)
            .filter(|upload| user.owns(upload))
            .ok_or_else(not_found)?;
        upload.last_active = (self.now)();
        update(upload)
    }
}

#[cfg(unix)]
fn create_private_dir(directory: &FsPath) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)?;
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn create_private_dir(directory: &FsPath) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)
}

struct Owner {
    user_id: String,
    library_id: String,
}

impl Owner {
    fn new(state: &ApiState, user: &SignedIn) -> Self {
        Self {
            user_id: user.0.id.clone(),
            library_id: state.access.library_id.clone(),
        }
    }

    fn owns(&self, upload: &Upload) -> bool {
        upload.user_id == self.user_id && upload.library_id == self.library_id
    }
}

impl Upload {
    fn view(&self, id: &str) -> StagedUpload {
        StagedUpload {
            id: id.to_string(),
            file_name: self.file_name.clone(),
            size: self.size,
            received_bytes: self.received,
            book: self.book.clone(),
        }
    }
}

/// The name a browser gave the file, reduced to its final component.
fn file_name(raw: &str) -> Result<(String, String, MIMETYPE), ApiFailure> {
    let name = raw.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    if name.is_empty() || name.chars().count() > MAX_FILE_NAME_CHARS || name.contains('\0') {
        return Err(LibraryError::invalid("Invalid file name").into());
    }
    let extension = FsPath::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let format = MIMETYPE::from_file_extension(&extension).ok_or_else(|| {
        LibraryError::invalid("Citadel can import EPUB, MOBI, AZW, AZW3, PDF and TXT files")
    })?;
    Ok((name.to_string(), extension, format))
}

#[utoipa::path(get, path = "/api/uploads", operation_id = "listUploads",
    responses((status = 200, body = UploadList), (status = 401, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn list(
    State(state): State<ApiState>,
    Extension(user): Extension<SignedIn>,
) -> Result<Json<UploadList>, ApiFailure> {
    let staging = &state.uploads;
    let owner = Owner::new(&state, &user);
    let uploads = staging
        .uploads
        .lock()
        .map_err(|_| LibraryError::unavailable())?
        .iter()
        .filter(|(_, upload)| owner.owns(upload))
        .map(|(id, upload)| upload.view(id))
        .collect();
    Ok(Json(UploadList {
        max_file_bytes: staging.config.max_file_bytes,
        chunk_bytes: staging.config.chunk_bytes,
        uploads,
    }))
}

#[utoipa::path(post, path = "/api/uploads", operation_id = "createUpload",
    request_body = CreateUpload,
    responses((status = 201, body = StagedUpload), (status = 400, body = LibraryError),
        (status = 401, body = LibraryError), (status = 413, body = LibraryError),
        (status = 507, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn create(
    State(state): State<ApiState>,
    Extension(user): Extension<SignedIn>,
    input: Result<Json<CreateUpload>, JsonRejection>,
) -> Result<(StatusCode, Json<StagedUpload>), ApiFailure> {
    let Json(input) = input.map_err(|_| LibraryError::invalid("Invalid upload JSON"))?;
    let (file_name, extension, format) = file_name(&input.file_name)?;
    let staging = &state.uploads;
    if input.size == 0 {
        return Err(LibraryError::invalid("The file is empty").into());
    }
    if input.size > staging.config.max_file_bytes {
        return Err(failure(
            LibraryErrorCode::TooLarge,
            format!(
                "Files can be at most {} MiB",
                staging.config.max_file_bytes / MIB
            ),
        ));
    }
    let owner = Owner::new(&state, &user);
    let mut uploads = staging
        .uploads
        .lock()
        .map_err(|_| LibraryError::unavailable())?;
    if uploads.values().filter(|upload| owner.owns(upload)).count()
        >= staging.config.max_uploads_per_user
    {
        return Err(failure(
            LibraryErrorCode::StorageFull,
            "Finish or cancel an upload before starting another",
        ));
    }
    // Reserve the declared size so concurrent uploads can't overrun the budget.
    let reserved: u64 = uploads.values().map(|upload| upload.size).sum();
    if reserved + input.size > staging.config.max_staged_bytes {
        return Err(failure(
            LibraryErrorCode::StorageFull,
            "The server has no room for this upload right now",
        ));
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let upload = Upload {
        user_id: owner.user_id,
        library_id: owner.library_id,
        file_name,
        extension,
        format,
        size: input.size,
        received: 0,
        last_active: (staging.now)(),
        busy: false,
        book: None,
    };
    let view = upload.view(&id);
    uploads.insert(id, upload);
    Ok((StatusCode::CREATED, Json(view)))
}

#[utoipa::path(get, path = "/api/uploads/{upload_id}", operation_id = "getUpload",
    params(("upload_id" = String, Path, description = "Upload ID")),
    responses((status = 200, body = StagedUpload), (status = 401, body = LibraryError),
        (status = 404, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn get(
    State(state): State<ApiState>,
    Extension(user): Extension<SignedIn>,
    Path(id): Path<String>,
) -> Result<Json<StagedUpload>, ApiFailure> {
    let owner = Owner::new(&state, &user);
    let view = state
        .uploads
        .with_upload(&id, &owner, |upload| Ok(upload.view(&id)))?;
    Ok(Json(view))
}

#[utoipa::path(delete, path = "/api/uploads/{upload_id}", operation_id = "cancelUpload",
    params(("upload_id" = String, Path, description = "Upload ID")),
    responses((status = 204, description = "Upload cancelled"), (status = 401, body = LibraryError),
        (status = 404, body = LibraryError), (status = 409, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn cancel(
    State(state): State<ApiState>,
    Extension(user): Extension<SignedIn>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiFailure> {
    let owner = Owner::new(&state, &user);
    let staging = &state.uploads;
    let extension = {
        let mut uploads = staging
            .uploads
            .lock()
            .map_err(|_| LibraryError::unavailable())?;
        let upload = uploads
            .get(&id)
            .filter(|upload| owner.owns(upload))
            .ok_or_else(not_found)?;
        if upload.busy {
            return Err(failure(
                LibraryErrorCode::Conflict,
                "A chunk is still being received",
            ));
        }
        let extension = upload.extension.clone();
        uploads.remove(&id);
        extension
    };
    staging.remove_files(&id, &extension);
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(get, path = "/api/uploads/{upload_id}/cover", operation_id = "getUploadCover",
    params(("upload_id" = String, Path, description = "Upload ID")),
    responses((status = 200, content_type = "image/jpeg", body = Vec<u8>),
        (status = 401, body = LibraryError), (status = 404, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn cover(
    State(state): State<ApiState>,
    Extension(user): Extension<SignedIn>,
    Path(id): Path<String>,
) -> Result<Response, ApiFailure> {
    let owner = Owner::new(&state, &user);
    let has_cover = state.uploads.with_upload(&id, &owner, |upload| {
        Ok(upload
            .book
            .as_ref()
            .is_some_and(|book| book.cover_url.is_some()))
    })?;
    if !has_cover {
        return Err(not_found());
    }
    let bytes = tokio::fs::read(state.uploads.cover_path(&id))
        .await
        .map_err(|_| not_found())?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, "private, no-store"),
        ],
        bytes,
    )
        .into_response())
}

/// The metadata the user reviewed, to add the upload to the library with.
#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CommitUpload {
    title: String,
    #[serde(default)]
    author_names: Vec<String>,
    /// Stored as the book's ISBN when it is one (`urn:isbn:` and `ISBN:`
    /// prefixes are accepted); other identifiers are ignored.
    identifier: Option<String>,
    publisher: Option<String>,
    language: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    publication_date: Option<NaiveDate>,
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn trimmed_list(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .filter_map(|value| trimmed(Some(value)))
        .collect()
}

/// Releases an upload claimed for adding to the library, unless it was added.
struct Committing {
    staging: Arc<Staging>,
    id: String,
}

impl Drop for Committing {
    fn drop(&mut self) {
        if let Ok(mut uploads) = self.staging.uploads.lock() {
            if let Some(upload) = uploads.get_mut(&self.id) {
                upload.busy = false;
                upload.last_active = (self.staging.now)();
            }
        }
    }
}

#[utoipa::path(post, path = "/api/uploads/{upload_id}/commit", operation_id = "commitUpload",
    params(("upload_id" = String, Path, description = "Upload ID")),
    request_body = CommitUpload,
    responses((status = 201, body = citadel_core::LibraryBook), (status = 400, body = LibraryError),
        (status = 401, body = LibraryError), (status = 404, body = LibraryError),
        (status = 409, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn commit(
    State(state): State<ApiState>,
    Extension(user): Extension<SignedIn>,
    Path(id): Path<String>,
    input: Result<Json<CommitUpload>, JsonRejection>,
) -> Result<(StatusCode, Json<citadel_core::LibraryBook>), ApiFailure> {
    let Json(input) = input.map_err(|_| LibraryError::invalid("Invalid book JSON"))?;
    let title =
        trimmed(Some(input.title)).ok_or_else(|| LibraryError::invalid("A book needs a title"))?;
    let staging = state.uploads.clone();
    let owner = Owner::new(&state, &user);
    let (path, extension) = staging.with_upload(&id, &owner, |upload| {
        if upload.busy {
            return Err(failure(LibraryErrorCode::Conflict, "The upload is busy"));
        }
        if upload.book.is_none() {
            return Err(failure(
                LibraryErrorCode::Conflict,
                "The upload hasn't finished",
            ));
        }
        if state.source.read_only() {
            return Err(failure(
                LibraryErrorCode::Conflict,
                "This library is open read-only",
            ));
        }
        upload.busy = true;
        Ok((
            staging.book_path(&id, &upload.extension),
            upload.extension.clone(),
        ))
    })?;
    let claim = Committing {
        staging: staging.clone(),
        id: id.clone(),
    };

    let actor = user.0.actor();
    let identifiers = trimmed(input.identifier)
        .as_deref()
        .and_then(book_file::isbn)
        .map(|isbn| HashMap::from([("isbn".to_string(), isbn)]))
        .unwrap_or_default();
    let tags = trimmed_list(input.tags);
    let book = libcalibre::BookAdd {
        title,
        author_names: trimmed_list(input.author_names),
        tags: (!tags.is_empty()).then_some(tags),
        series: None,
        series_index: None,
        publisher: trimmed(input.publisher),
        publication_date: input.publication_date,
        rating: None,
        comments: None,
        language: trimmed(input.language),
        identifiers,
        file_paths: vec![path],
    };
    let book = super::run(state.clone(), move |service| {
        let id = service.create_book(&actor, book)?;
        service.get_book(&id)
    })
    .await?;

    // The library holds its own copy now.
    drop(claim);
    discard(&staging, &id, &extension);
    Ok((StatusCode::CREATED, Json(book)))
}

/// Ends a chunk transfer. If the chunk didn't complete (an error, or the
/// client went away and the handler was dropped), the file is cut back to
/// where the chunk began so the client can resend it.
struct Receiving {
    staging: Arc<Staging>,
    id: String,
    path: PathBuf,
    offset: u64,
    received: Option<u64>,
}

impl Drop for Receiving {
    fn drop(&mut self) {
        if self.received.is_none() {
            if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&self.path) {
                let _ = file.set_len(self.offset);
            }
        }
        if let Ok(mut uploads) = self.staging.uploads.lock() {
            if let Some(upload) = uploads.get_mut(&self.id) {
                upload.busy = false;
                upload.last_active = (self.staging.now)();
                if let Some(received) = self.received {
                    upload.received = received;
                }
            }
        }
    }
}

#[utoipa::path(patch, path = "/api/uploads/{upload_id}/content", operation_id = "sendUploadChunk",
    params(("upload_id" = String, Path, description = "Upload ID"),
        ("Upload-Offset" = u64, Header, description = "Byte offset of this chunk; must equal receivedBytes")),
    request_body(content = Vec<u8>, content_type = "application/octet-stream",
        description = "The next bytes of the file, at most chunkBytes"),
    responses((status = 200, body = StagedUpload), (status = 400, body = LibraryError),
        (status = 401, body = LibraryError), (status = 404, body = LibraryError),
        (status = 409, body = LibraryError), (status = 413, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn receive(
    State(state): State<ApiState>,
    Extension(user): Extension<SignedIn>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<StagedUpload>, ApiFailure> {
    let offset = headers
        .get(UPLOAD_OFFSET)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| LibraryError::invalid("Upload-Offset must be a byte offset"))?;
    let staging = state.uploads.clone();
    let owner = Owner::new(&state, &user);
    let (size, format, extension, file_name) = staging.with_upload(&id, &owner, |upload| {
        if upload.busy {
            return Err(failure(
                LibraryErrorCode::Conflict,
                "A chunk is already being received",
            ));
        }
        if upload.received == upload.size {
            return Err(failure(
                LibraryErrorCode::Conflict,
                "The upload is already complete",
            ));
        }
        if offset != upload.received {
            return Err(failure(
                LibraryErrorCode::Conflict,
                format!("The next chunk starts at byte {}", upload.received),
            ));
        }
        upload.busy = true;
        Ok((
            upload.size,
            upload.format,
            upload.extension.clone(),
            upload.file_name.clone(),
        ))
    })?;
    let path = staging.book_path(&id, &extension);
    let mut transfer = Receiving {
        staging: staging.clone(),
        id: id.clone(),
        path: path.clone(),
        offset,
        received: None,
    };

    let limit = staging.config.chunk_bytes.min(size - offset);
    let too_large = || {
        failure(
            LibraryErrorCode::TooLarge,
            format!("Chunks can be at most {limit} bytes here"),
        )
    };
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|length| length > limit) {
        return Err(too_large());
    }

    let mut file = open_staged_file(&path, offset).await?;
    let mut head = Vec::new();
    let mut written = 0u64;
    let mut stream = body.into_data_stream();
    loop {
        let chunk = match tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(chunk))) => chunk,
            Ok(None) => break,
            Ok(Some(Err(_))) => {
                return Err(LibraryError::invalid("The chunk was interrupted").into())
            }
            Err(_) => {
                return Err(failure(
                    LibraryErrorCode::Unavailable,
                    "The chunk stopped arriving",
                ))
            }
        };
        written += chunk.len() as u64;
        if written > limit {
            return Err(too_large());
        }
        if offset == 0 && head.len() < book_file::CONTENT_CHECK_BYTES {
            let wanted = book_file::CONTENT_CHECK_BYTES - head.len();
            head.extend_from_slice(&chunk[..chunk.len().min(wanted)]);
        }
        file.write_all(&chunk)
            .await
            .map_err(|_| LibraryError::unavailable())?;
    }
    file.flush()
        .await
        .map_err(|_| LibraryError::unavailable())?;
    drop(file);

    if offset == 0 {
        let needed = (book_file::CONTENT_CHECK_BYTES as u64).min(size) as usize;
        if head.len() < needed {
            return Err(LibraryError::invalid(format!(
                "The first chunk must hold at least {needed} bytes"
            ))
            .into());
        }
        if !book_file::content_matches(format, &head) {
            drop(transfer);
            discard(&staging, &id, &extension);
            return Err(LibraryError::invalid(format!(
                "This isn't a valid {} file",
                extension.to_ascii_uppercase()
            ))
            .into());
        }
    }

    let received = offset + written;
    if received == size {
        let book = read_book(&state, &staging, &id, &path, file_name, extension).await?;
        staging.with_upload(&id, &owner, |upload| {
            upload.book = Some(book);
            Ok(())
        })?;
    }
    transfer.received = Some(received);
    drop(transfer);
    let view = staging.with_upload(&id, &owner, |upload| Ok(upload.view(&id)))?;
    Ok(Json(view))
}

async fn open_staged_file(path: &FsPath, offset: u64) -> Result<tokio::fs::File, ApiFailure> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .await
        .map_err(|_| LibraryError::unavailable())?;
    file.set_len(offset)
        .await
        .map_err(|_| LibraryError::unavailable())?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|_| LibraryError::unavailable())?;
    Ok(file)
}

fn discard(staging: &Staging, id: &str, extension: &str) {
    if let Ok(mut uploads) = staging.uploads.lock() {
        uploads.remove(id);
    }
    staging.remove_files(id, extension);
}

/// Reads the complete file's metadata and writes a cover preview beside it.
async fn read_book(
    state: &ApiState,
    staging: &Arc<Staging>,
    id: &str,
    path: &FsPath,
    file_name: String,
    extension: String,
) -> Result<StagedBook, ApiFailure> {
    let permit = state
        .work
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| LibraryError::unavailable())?;
    let path = path.to_path_buf();
    let cover_path = staging.cover_path(id);
    let cover_url = format!("/api/uploads/{id}/cover");
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let metadata = book_file::read_metadata(&path);
        let has_cover = metadata.as_ref().is_some_and(|metadata| metadata.has_cover)
            && book_file::cover_image_data(&path)
                .and_then(|cover| {
                    let reader = ImageReader::new(Cursor::new(cover));
                    resized_jpeg(reader, 600, 600)
                })
                .is_some_and(|(preview, _, _)| std::fs::write(&cover_path, preview).is_ok());
        let fallback_title = FsPath::new(&file_name)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or(&file_name)
            .to_string();
        let metadata = metadata.unwrap_or(book_file::BookFileMetadata {
            format: MIMETYPE::UNKNOWN,
            title: None,
            author_names: Vec::new(),
            identifier: None,
            publisher: None,
            language: None,
            tags: Vec::new(),
            publication_date: None,
            has_cover: false,
        });
        // PDF and TXT titles come from the file's name, which here is the
        // staging ID rather than the name the user uploaded.
        let title = match metadata.format {
            MIMETYPE::PDF | MIMETYPE::TXT => None,
            _ => metadata.title,
        };
        StagedBook {
            format: extension,
            title: title.unwrap_or(fallback_title),
            author_names: metadata.author_names,
            identifier: metadata.identifier,
            publisher: metadata.publisher,
            language: metadata.language,
            tags: metadata.tags,
            publication_date: metadata.publication_date,
            cover_url: has_cover.then_some(cover_url),
        }
    })
    .await
    .map_err(|_| LibraryError::unavailable().into())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    fn upload(last_active: Instant, busy: bool) -> Upload {
        Upload {
            user_id: "user".into(),
            library_id: "library".into(),
            file_name: "book.txt".into(),
            extension: "txt".into(),
            format: MIMETYPE::TXT,
            size: 4,
            received: 0,
            last_active,
            busy,
            book: None,
        }
    }

    #[test]
    fn sweeping_removes_idle_uploads_and_stray_files() {
        let directory = tempfile::tempdir().unwrap();
        let start = Instant::now();
        let elapsed = Arc::new(AtomicU64::new(0));
        let clock = elapsed.clone();
        let staging = Staging::open_with_clock(
            directory.path().join("uploads"),
            UploadConfig::default(),
            Box::new(move || start + Duration::from_secs(clock.load(Ordering::SeqCst))),
        )
        .unwrap();
        {
            let mut uploads = staging.uploads.lock().unwrap();
            uploads.insert("idle".into(), upload(start, false));
            uploads.insert("busy".into(), upload(start, true));
        }
        for name in ["idle.txt", "idle.cover.jpg", "busy.txt", "stray.txt"] {
            std::fs::write(staging.directory.join(name), b"data").unwrap();
        }

        elapsed.store(EXPIRY.as_secs() - 1, Ordering::SeqCst);
        staging.sweep();
        assert!(staging.directory.join("idle.txt").exists());
        assert!(!staging.directory.join("stray.txt").exists());

        elapsed.store(EXPIRY.as_secs(), Ordering::SeqCst);
        staging.sweep();
        let mut left: Vec<_> = std::fs::read_dir(&staging.directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, ["busy.txt"]);
        assert!(staging.uploads.lock().unwrap().contains_key("busy"));
        assert!(!staging.uploads.lock().unwrap().contains_key("idle"));
    }

    #[test]
    fn file_names_keep_only_their_final_component() {
        let (name, extension, format) = file_name("../../etc/Notes.TXT").ok().unwrap();
        assert_eq!(
            (name.as_str(), extension.as_str(), format),
            ("Notes.TXT", "txt", MIMETYPE::TXT)
        );
        assert!(file_name("folder/").is_err());
        assert!(file_name("book").is_err());
        assert!(file_name(&format!("{}.epub", "a".repeat(300))).is_err());
    }

    #[test]
    fn config_limits_are_validated() {
        assert!(UploadConfig::default().validate().is_ok());
        for config in [
            UploadConfig {
                chunk_bytes: 1024,
                ..Default::default()
            },
            UploadConfig {
                max_file_bytes: 0,
                ..Default::default()
            },
            UploadConfig {
                max_staged_bytes: MIB,
                ..Default::default()
            },
            UploadConfig {
                max_uploads_per_user: 0,
                ..Default::default()
            },
        ] {
            assert!(config.validate().is_err(), "{config:?}");
        }
    }
}
