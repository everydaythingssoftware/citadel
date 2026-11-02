//! Staged book uploads. A browser declares a file, sends it in chunks that
//! stream straight to disk, and gets back the metadata and cover read from
//! it for review. Staged files live in the server's state directory, never
//! inside the library. An unfinished upload expires once it goes idle; a
//! finished one waits a fixed review window for the user to add or skip it.
//! A small record beside each file lets uploads survive a server restart.
use std::{
    collections::HashMap,
    io::Cursor,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::{Duration, SystemTime},
};

use axum::{
    body::Body,
    extract::{rejection::JsonRejection, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, NaiveDate, Utc};
use citadel_core::error::{LibraryError, LibraryErrorCode};
use futures_util::StreamExt;
use image::ImageReader;
use libcalibre::{book_file, mime_type::MIMETYPE};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use super::{session::SignedIn, thumbnails::resized_jpeg, ApiFailure, ApiState};

const MIB: u64 = 1024 * 1024;
/// An unfinished upload that receives nothing for this long is discarded.
const IDLE_EXPIRY: Duration = Duration::from_secs(60 * 60);
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
    /// How long a finished upload waits for the user to add or skip it.
    pub review_hours: u64,
}

impl Default for UploadConfig {
    fn default() -> Self {
        Self {
            max_file_bytes: 200 * MIB,
            chunk_bytes: 8 * MIB,
            max_staged_bytes: 2048 * MIB,
            max_uploads_per_user: 100,
            review_hours: 24,
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
        if !(1..=24 * 365).contains(&self.review_hours) {
            return Err("api.uploads.reviewHours must be between 1 and 8760 (a year)".into());
        }
        Ok(())
    }

    fn review_window(&self) -> Duration {
        Duration::from_secs(self.review_hours * 60 * 60)
    }
}

/// The uploads in progress and the directory holding their files.
pub struct Staging {
    directory: PathBuf,
    config: UploadConfig,
    uploads: Mutex<HashMap<String, Upload>>,
    now: Box<dyn Fn() -> SystemTime + Send + Sync>,
}

struct Upload {
    user_id: String,
    library_id: String,
    file_name: String,
    extension: String,
    format: MIMETYPE,
    size: u64,
    received: u64,
    last_active: SystemTime,
    /// A chunk is being written or the upload is being added to the
    /// library; one thing at a time.
    busy: bool,
    book: Option<StagedBook>,
    /// When the file was read; the review window counts from here.
    ready_at: Option<SystemTime>,
}

/// What survives a restart: everything but the received byte count, which
/// is the staged file's length.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadRecord {
    user_id: String,
    library_id: String,
    file_name: String,
    extension: String,
    size: u64,
    book: Option<StagedBook>,
    ready_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadList {
    max_file_bytes: u64,
    chunk_bytes: u64,
    /// How long a finished upload waits to be added or skipped.
    review_seconds: u64,
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
    /// When the server discards the upload: a fixed review deadline once the
    /// file has been read, otherwise an hour after its last chunk.
    expires_at: DateTime<Utc>,
}

/// What the uploaded file says about itself, for the user to review.
#[derive(Clone, Serialize, Deserialize, utoipa::ToSchema)]
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
    /// Opens the staging directory and restores the uploads recorded there by
    /// an earlier run. Anything without a usable record is removed.
    pub fn open(directory: PathBuf, config: UploadConfig) -> Result<Arc<Self>, String> {
        Self::open_with_clock(directory, config, Box::new(SystemTime::now))
    }

    fn open_with_clock(
        directory: PathBuf,
        config: UploadConfig,
        now: Box<dyn Fn() -> SystemTime + Send + Sync>,
    ) -> Result<Arc<Self>, String> {
        let describe =
            |error: std::io::Error| format!("could not prepare {}: {error}", directory.display());
        create_private_dir(&directory).map_err(describe)?;
        let mut records = Vec::new();
        for entry in std::fs::read_dir(&directory).map_err(describe)? {
            let path = entry.map_err(describe)?.path();
            if path.is_dir() {
                std::fs::remove_dir_all(&path).map_err(describe)?;
                continue;
            }
            if path
                .extension()
                .is_some_and(|extension| extension == "partial")
            {
                std::fs::remove_file(&path).map_err(describe)?;
                continue;
            }
            let id = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_suffix(".json"))
                .filter(|id| is_upload_id(id));
            if let Some(id) = id {
                match std::fs::read(&path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<UploadRecord>(&bytes).ok())
                {
                    Some(record) => records.push((id.to_string(), record)),
                    None => std::fs::remove_file(&path).map_err(describe)?,
                }
            }
        }
        let staging = Self {
            directory,
            config,
            uploads: Mutex::default(),
            now,
        };
        let restored: HashMap<String, Upload> = records
            .into_iter()
            .filter_map(|(id, record)| {
                let upload = staging.restore(&id, record)?;
                Some((id, upload))
            })
            .collect();
        *staging
            .uploads
            .lock()
            .map_err(|_| "staging lock poisoned")? = restored;
        staging.sweep();
        Ok(Arc::new(staging))
    }

    /// Rebuilds an upload from its record and file, or `None` when it can't
    /// continue: its file is missing or inconsistent, or its time is up.
    fn restore(&self, id: &str, record: UploadRecord) -> Option<Upload> {
        let format = MIMETYPE::from_file_extension(&record.extension)?;
        let path = self.book_path(id, &record.extension);
        let mut received = std::fs::metadata(&path).ok()?.len();
        if received > record.size || (record.book.is_some() && received != record.size) {
            return None;
        }
        if record.book.is_none() {
            // A crash can leave a whole file that was never read; it would
            // need re-reading that nothing triggers, so it starts over.
            if received == record.size {
                received = 0;
            }
            let needed = (book_file::CONTENT_CHECK_BYTES as u64).min(record.size);
            if received < needed {
                received = 0;
            } else {
                let mut head = vec![0; needed as usize];
                let mut file = std::fs::File::open(&path).ok()?;
                std::io::Read::read_exact(&mut file, &mut head).ok()?;
                if !book_file::content_matches(format, &head) {
                    return None;
                }
            }
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .and_then(|file| file.set_len(received))
                .ok()?;
        }
        let upload = Upload {
            user_id: record.user_id,
            library_id: record.library_id,
            file_name: record.file_name,
            extension: record.extension,
            format,
            size: record.size,
            received,
            last_active: (self.now)(),
            busy: false,
            book: record.book,
            ready_at: record.ready_at.map(SystemTime::from),
        };
        let expired = (self.now)() >= upload.expires_at(&self.config);
        (!expired).then_some(upload)
    }

    /// Writes the upload's record beside its file so it survives a restart.
    fn persist(&self, id: &str, upload: &Upload) {
        let record = UploadRecord {
            user_id: upload.user_id.clone(),
            library_id: upload.library_id.clone(),
            file_name: upload.file_name.clone(),
            extension: upload.extension.clone(),
            size: upload.size,
            book: upload.book.clone(),
            ready_at: upload.ready_at.map(DateTime::<Utc>::from),
        };
        let Ok(bytes) = serde_json::to_vec(&record) else {
            return;
        };
        let temporary = self.directory.join(format!("{id}.json.partial"));
        if write_private(&temporary, &bytes).is_ok() {
            let _ = std::fs::rename(&temporary, self.record_path(id));
        }
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

    /// Removes uploads past their expiry, and any file that belongs to no
    /// upload (one whose removal failed earlier).
    fn sweep(&self) {
        let now = (self.now)();
        let live: Vec<String> = {
            let Ok(mut uploads) = self.uploads.lock() else {
                return;
            };
            uploads.retain(|_, upload| upload.busy || now < upload.expires_at(&self.config));
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

    fn record_path(&self, id: &str) -> PathBuf {
        self.directory.join(format!("{id}.json"))
    }

    fn remove_files(&self, id: &str, extension: &str) {
        let _ = std::fs::remove_file(self.record_path(id));
        let _ = std::fs::remove_file(self.book_path(id, extension));
        let _ = std::fs::remove_file(self.cover_path(id));
    }

    /// Runs `update` on an upload the user owns, marking it active. Activity
    /// keeps an unfinished upload alive; a finished one keeps its deadline.
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

fn write_private(path: &FsPath, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    std::io::Write::write_all(&mut options.open(path)?, bytes)
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
    fn expires_at(&self, config: &UploadConfig) -> SystemTime {
        match self.ready_at {
            Some(ready_at) => ready_at + config.review_window(),
            None => self.last_active + IDLE_EXPIRY,
        }
    }

    fn view(&self, id: &str, config: &UploadConfig) -> StagedUpload {
        StagedUpload {
            id: id.to_string(),
            file_name: self.file_name.clone(),
            size: self.size,
            received_bytes: self.received,
            book: self.book.clone(),
            expires_at: self.expires_at(config).into(),
        }
    }
}

/// Upload IDs are server-generated simple UUIDs.
fn is_upload_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
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
        .map(|(id, upload)| upload.view(id, &staging.config))
        .collect();
    Ok(Json(UploadList {
        max_file_bytes: staging.config.max_file_bytes,
        chunk_bytes: staging.config.chunk_bytes,
        review_seconds: staging.config.review_window().as_secs(),
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
        ready_at: None,
    };
    let view = upload.view(&id, &staging.config);
    staging.persist(&id, &upload);
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
    let staging = &state.uploads;
    let view = staging.with_upload(&id, &owner, |upload| Ok(upload.view(&id, &staging.config)))?;
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
        (status = 401, body = LibraryError), (status = 403, body = LibraryError),
        (status = 404, body = LibraryError), (status = 409, body = LibraryError)),
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
            return Err(LibraryError::read_only().into());
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
    let book = super::write(state.clone(), move |service| {
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
            upload.ready_at = Some((staging.now)());
            upload.received = received;
            staging.persist(&id, upload);
            Ok(())
        })?;
    }
    transfer.received = Some(received);
    drop(transfer);
    let view = staging.with_upload(&id, &owner, |upload| Ok(upload.view(&id, &staging.config)))?;
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

    const HOUR: u64 = 60 * 60;

    fn upload(last_active: SystemTime, busy: bool) -> Upload {
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
            ready_at: None,
        }
    }

    fn book() -> StagedBook {
        StagedBook {
            format: "txt".into(),
            title: "Book".into(),
            author_names: vec!["Author".into()],
            identifier: None,
            publisher: None,
            language: None,
            tags: Vec::new(),
            publication_date: None,
            cover_url: None,
        }
    }

    /// A staging area whose clock reads `start` plus the returned counter's
    /// seconds.
    fn staging_at(directory: &FsPath, start: SystemTime) -> (Arc<Staging>, Arc<AtomicU64>) {
        let elapsed = Arc::new(AtomicU64::new(0));
        let clock = elapsed.clone();
        let staging = Staging::open_with_clock(
            directory.join("uploads"),
            UploadConfig::default(),
            Box::new(move || start + Duration::from_secs(clock.load(Ordering::SeqCst))),
        )
        .unwrap();
        (staging, elapsed)
    }

    fn id(n: u8) -> String {
        format!("{n:032x}")
    }

    #[test]
    fn sweeping_removes_idle_uploads_and_stray_files() {
        let directory = tempfile::tempdir().unwrap();
        let start = SystemTime::now();
        let (staging, elapsed) = staging_at(directory.path(), start);
        {
            let mut uploads = staging.uploads.lock().unwrap();
            uploads.insert("idle".into(), upload(start, false));
            uploads.insert("busy".into(), upload(start, true));
        }
        for name in ["idle.txt", "idle.cover.jpg", "busy.txt", "stray.txt"] {
            std::fs::write(staging.directory.join(name), b"data").unwrap();
        }

        elapsed.store(IDLE_EXPIRY.as_secs() - 1, Ordering::SeqCst);
        staging.sweep();
        assert!(staging.directory.join("idle.txt").exists());
        assert!(!staging.directory.join("stray.txt").exists());

        elapsed.store(IDLE_EXPIRY.as_secs(), Ordering::SeqCst);
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
    fn finished_uploads_keep_a_fixed_review_deadline_despite_activity() {
        let directory = tempfile::tempdir().unwrap();
        let start = SystemTime::now();
        let (staging, elapsed) = staging_at(directory.path(), start);
        let mut ready = upload(start, false);
        ready.book = Some(book());
        ready.ready_at = Some(start);
        let config = UploadConfig::default();
        assert_eq!(
            ready.expires_at(&config),
            start + Duration::from_secs(24 * HOUR)
        );
        staging
            .uploads
            .lock()
            .unwrap()
            .insert("ready".into(), ready);
        let owner = Owner {
            user_id: "user".into(),
            library_id: "library".into(),
        };

        elapsed.store(24 * HOUR - 1, Ordering::SeqCst);
        staging
            .with_upload("ready", &owner, |_| Ok(()))
            .ok()
            .unwrap();
        staging.sweep();
        assert!(staging.uploads.lock().unwrap().contains_key("ready"));

        elapsed.store(24 * HOUR, Ordering::SeqCst);
        staging.sweep();
        assert!(!staging.uploads.lock().unwrap().contains_key("ready"));
    }

    #[test]
    fn recorded_uploads_survive_reopening_the_staging_area() {
        let directory = tempfile::tempdir().unwrap();
        let start = SystemTime::now();
        let (staging, _) = staging_at(directory.path(), start);
        let text = "Plain text, long enough for the content check. ".repeat(40);
        let text = text.as_bytes();

        let mut ready = upload(start, false);
        ready.size = text.len() as u64;
        ready.received = ready.size;
        ready.book = Some(book());
        ready.ready_at = Some(start);
        let mut partial = upload(start, false);
        partial.size = 100_000;
        partial.received = text.len() as u64;
        let mut expired = upload(start, false);
        expired.size = text.len() as u64;
        expired.received = expired.size;
        expired.book = Some(book());
        expired.ready_at = Some(start - Duration::from_secs(25 * HOUR));
        let missing = upload(start, false);
        for (id, upload) in [(id(1), &ready), (id(2), &partial), (id(3), &expired)] {
            std::fs::write(staging.book_path(&id, "txt"), text).unwrap();
            staging.persist(&id, upload);
        }
        staging.persist(&id(4), &missing);
        std::fs::write(
            staging.directory.join(format!("{}.json", id(5))),
            b"not json",
        )
        .unwrap();
        drop(staging);

        let (reopened, _) = staging_at(directory.path(), start + Duration::from_secs(HOUR));
        let uploads = reopened.uploads.lock().unwrap();
        let mut ids: Vec<_> = uploads.keys().cloned().collect();
        ids.sort();
        assert_eq!(ids, [id(1), id(2)]);
        let restored = &uploads[&id(1)];
        assert_eq!(restored.received, restored.size);
        assert_eq!(restored.book.as_ref().unwrap().title, "Book");
        assert_eq!(restored.ready_at, Some(start));
        assert_eq!(uploads[&id(2)].received, text.len() as u64);
        assert!(!uploads[&id(2)].busy);
        drop(uploads);
        let mut left: Vec<_> = std::fs::read_dir(&reopened.directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        let mut expected = vec![
            format!("{}.json", id(1)),
            format!("{}.txt", id(1)),
            format!("{}.json", id(2)),
            format!("{}.txt", id(2)),
        ];
        expected.sort();
        assert_eq!(left, expected);
    }

    #[test]
    fn restored_partial_uploads_too_short_to_check_start_over() {
        let directory = tempfile::tempdir().unwrap();
        let start = SystemTime::now();
        let (staging, _) = staging_at(directory.path(), start);
        let mut partial = upload(start, false);
        partial.size = 100_000;
        std::fs::write(staging.book_path(&id(1), "txt"), b"ab").unwrap();
        staging.persist(&id(1), &partial);
        drop(staging);

        let (reopened, _) = staging_at(directory.path(), start);
        assert_eq!(reopened.uploads.lock().unwrap()[&id(1)].received, 0);
        assert_eq!(
            std::fs::metadata(reopened.book_path(&id(1), "txt"))
                .unwrap()
                .len(),
            0
        );
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
            UploadConfig {
                review_hours: 0,
                ..Default::default()
            },
        ] {
            assert!(config.validate().is_err(), "{config:?}");
        }
    }
}
