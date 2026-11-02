use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};

use axum::{
    extract::{rejection::JsonRejection, Path, State},
    http::header,
    response::{IntoResponse, Response},
    Json,
};
use citadel_core::error::{LibraryError, LibraryErrorCode};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, ImageReader, Limits};
use serde::{Deserialize, Serialize};

use super::{run_library, ApiFailure, ApiState};

const CACHE_CAPACITY: usize = 256;
#[derive(Clone, Serialize, utoipa::ToSchema)]
pub(super) struct CoverThumbnail {
    book_id: String,
    url: String,
    width: u32,
    height: u32,
}

#[derive(Clone)]
pub(super) struct CachedThumbnail {
    version: String,
    descriptor: CoverThumbnail,
    bytes: Vec<u8>,
}
pub(super) type ThumbnailCache = Arc<Mutex<HashMap<String, CachedThumbnail>>>;

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ThumbnailQuery {
    book_ids: Vec<String>,
}

#[utoipa::path(post, path = "/api/covers/thumbnails", operation_id = "ensureCoverThumbnails",
    request_body = ThumbnailQuery,
    responses((status = 200, body = Vec<CoverThumbnail>), (status = 400, body = LibraryError),
        (status = 401, body = LibraryError), (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn ensure(
    State(state): State<ApiState>,
    input: Result<Json<ThumbnailQuery>, JsonRejection>,
) -> Result<Json<Vec<CoverThumbnail>>, ApiFailure> {
    let Json(query) = input.map_err(|_| LibraryError::invalid("Invalid thumbnail query JSON"))?;
    if query.book_ids.len() > 200 {
        return Err(LibraryError::invalid("At most 200 thumbnail IDs are allowed").into());
    }
    if query.book_ids.iter().any(|id| id.parse::<i32>().is_err()) {
        return Err(LibraryError::invalid("Invalid book ID").into());
    }
    let mut thumbnails = Vec::new();
    for id in query.book_ids {
        match generate(state.clone(), id).await {
            Ok(thumbnail) => thumbnails.push(thumbnail.descriptor),
            Err(ApiFailure(error)) if error.code == LibraryErrorCode::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(Json(thumbnails))
}

#[utoipa::path(get, path = "/api/covers/thumbnails", operation_id = "listCoverThumbnails",
    description = "Cached thumbnails only. The bounded in-memory index is rebuilt on demand after a restart.",
    responses((status = 200, body = Vec<CoverThumbnail>), (status = 401, body = LibraryError), (status = 503, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn list(
    State(state): State<ApiState>,
) -> Result<Json<Vec<CoverThumbnail>>, ApiFailure> {
    let cache = state
        .thumbnails
        .lock()
        .map_err(|_| LibraryError::unavailable())?;
    let mut descriptors: Vec<_> = cache
        .values()
        .map(|cached| cached.descriptor.clone())
        .collect();
    descriptors.sort_by(|left, right| left.book_id.cmp(&right.book_id));
    Ok(Json(descriptors))
}

#[utoipa::path(get, path = "/api/books/{book_id}/thumbnail", operation_id = "getCoverThumbnail",
    params(("book_id" = String, Path)),
    responses((status = 200, body = Vec<u8>, content_type = "image/jpeg"),
        (status = 400, body = LibraryError), (status = 401, body = LibraryError),
        (status = 404, body = LibraryError), (status = 503, body = LibraryError), (status = 500, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn image(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Response, ApiFailure> {
    let thumbnail = generate(state, id).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, "private, max-age=300"),
        ],
        thumbnail.bytes,
    )
        .into_response())
}

async fn generate(state: ApiState, id: String) -> Result<CachedThumbnail, ApiFailure> {
    let book_id = id
        .parse::<i32>()
        .map(libcalibre::BookId::from)
        .map_err(|_| LibraryError::invalid("Invalid book ID"))?;
    let asset = run_library(state.clone(), move |library| {
        library
            .resolve_book_cover(book_id)
            .map_err(|error| match error {
                libcalibre::CalibreError::AssetFileMissing(_) => LibraryError {
                    code: LibraryErrorCode::NotFound,
                    message: "Cover thumbnail unavailable".into(),
                },
                error => error.into(),
            })
    })
    .await?;
    let permit = state
        .work
        .try_acquire_owned()
        .map_err(|_| LibraryError::unavailable())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let missing = || LibraryError {
            code: LibraryErrorCode::NotFound,
            message: "Cover thumbnail unavailable".into(),
        };
        let metadata = std::fs::metadata(asset.canonical_path()).map_err(|_| missing())?;
        if metadata.len() > 32 * 1024 * 1024 {
            return Err(missing());
        }
        let modified = metadata
            .modified()
            .ok()
            .and_then(|mtime| mtime.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let version = format!("{modified}-{}", metadata.len());
        if let Some(cached) = state
            .thumbnails
            .lock()
            .map_err(|_| LibraryError::unavailable())?
            .get(&id)
            .filter(|cached| cached.version == version)
            .cloned()
        {
            return Ok(cached);
        }
        let reader = ImageReader::open(asset.canonical_path()).map_err(|_| missing())?;
        let (bytes, width, height) = resized_jpeg(reader, 300, 600).ok_or_else(missing)?;
        let cached = CachedThumbnail {
            version: version.clone(),
            descriptor: CoverThumbnail {
                book_id: id.clone(),
                url: format!("/api/books/{id}/thumbnail?v={version}"),
                width,
                height,
            },
            bytes,
        };
        let mut cache = state
            .thumbnails
            .lock()
            .map_err(|_| LibraryError::unavailable())?;
        if cache.len() >= CACHE_CAPACITY {
            if let Some(evicted) = cache.keys().next().cloned() {
                cache.remove(&evicted);
            }
        }
        cache.insert(id, cached.clone());
        Ok(cached)
    })
    .await
    .map_err(|_| LibraryError::unavailable())?
    .map_err(Into::into)
}

/// Decodes an image (within memory and size limits) and re-encodes it as a
/// JPEG that fits `max_width` × `max_height`. Returns the bytes and size.
pub(super) fn resized_jpeg<R: std::io::BufRead + std::io::Seek>(
    reader: ImageReader<R>,
    max_width: u32,
    max_height: u32,
) -> Option<(Vec<u8>, u32, u32)> {
    let mut reader = reader.with_guessed_format().ok()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(10000);
    limits.max_image_height = Some(10000);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .ok()?
        .resize(max_width, max_height, FilterType::Triangle)
        .to_rgb8();
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 80)
        .encode_image(&image)
        .ok()?;
    Some((bytes, image.width(), image.height()))
}
