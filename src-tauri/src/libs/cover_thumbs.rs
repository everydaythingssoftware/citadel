//! Grid-sized cover thumbnails.
//!
//! The library grid renders covers at ~150 CSS px (300 device px at 2×), but
//! Calibre stores `cover.jpg` at full resolution — often 1200×1800+. Decoding
//! those during scroll saturates the main thread and paints half-finished
//! frames. This module maintains a per-library cache of 300px JPEG thumbnails
//! so the grid decodes only small images.
//!
//! Cache layout (inside the app cache dir):
//! `cover-thumbs/<library-root-hash>/{book_id}-{cover_mtime_ms}.jpg`
//! with a single `thumbs.json` index holding mtime/dimensions per book. The
//! mtime in the file name doubles as cache busting for the webview's image
//! cache when a cover is replaced.

use std::collections::HashMap;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use citadel_core::{cover_colors::cover_colors, path_to_asset_url, CoverColors};
use image::imageops::FilterType;
use serde::{Deserialize, Serialize};

/// Thumbnail width in device pixels: 2× the grid's ~150 CSS px cells.
const THUMB_WIDTH: u32 = 300;
/// Tall covers are capped so a degenerate aspect ratio cannot explode the
/// output; the grid letterboxes anything taller than 2:1 anyway.
const THUMB_MAX_HEIGHT: u32 = 600;
const THUMB_JPEG_QUALITY: u8 = 80;

/// What the frontend needs to render one grid cover: a small image URL and the
/// thumbnail's pixel dimensions (same aspect ratio as the source cover) to
/// reserve exact row height up front.
#[derive(Serialize, Clone, Debug, specta::Type)]
pub struct CoverThumbnail {
    pub book_id: String,
    pub url: String,
    pub width: u32,
    pub height: u32,
    /// The cover's palette and ThumbHash, worked out with the thumbnail.
    pub cover_colors: Option<CoverColors>,
}

/// One book's entry in `thumbs.json`.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct ThumbMeta {
    cover_mtime_ms: i64,
    file_name: String,
    width: u32,
    height: u32,
    /// Absent in entries written before colours were added; those count as
    /// stale and are regenerated.
    #[serde(default)]
    cover_colors: Option<CoverColors>,
}

type ThumbIndex = HashMap<String, ThumbMeta>;

/// Serializes index reads and read-modify-writes across overlapping calls
/// (grid-page ensures and the whole-library warm pass run concurrently).
/// Generation work happens OUTSIDE the lock — a multi-minute first-run warm
/// must not block the visible page's thumbnails. Two batches generating the
/// same book race harmlessly: same mtime → same file name and content, and
/// the merge step re-reads the index before writing.
static INDEX_LOCK: Mutex<()> = Mutex::new(());

/// A book the caller wants a thumbnail for: id plus the absolute path to its
/// cover.jpg. Books without covers are filtered out by the caller.
pub struct CoverSource {
    pub book_id: String,
    pub cover_path: PathBuf,
}

/// The per-library cache directory: stable across runs, distinct per library
/// root (DefaultHasher is deterministic, unlike RandomState).
pub fn thumb_cache_dir(app_cache_dir: &Path, library_root: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    library_root.hash(&mut hasher);
    app_cache_dir
        .join("cover-thumbs")
        .join(format!("{:016x}", hasher.finish()))
}

fn index_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join("thumbs.json")
}

fn load_index(cache_dir: &Path) -> ThumbIndex {
    fs::read(index_path(cache_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn store_index(cache_dir: &Path, index: &ThumbIndex) {
    if let Ok(bytes) = serde_json::to_vec(index) {
        // Write-then-rename so a crash mid-write cannot truncate the index
        // (a lost index only costs regeneration, but it is cheap to avoid).
        let tmp = index_path(cache_dir).with_extension("json.tmp");
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(&tmp, index_path(cache_dir));
        }
    }
}

fn cover_mtime_ms(cover_path: &Path) -> Option<i64> {
    let mtime = fs::metadata(cover_path).ok()?.modified().ok()?;
    let since_epoch = mtime.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(since_epoch.as_millis() as i64)
}

fn to_thumbnail(book_id: &str, cache_dir: &Path, meta: &ThumbMeta) -> CoverThumbnail {
    CoverThumbnail {
        book_id: book_id.to_string(),
        url: path_to_asset_url(&cache_dir.join(&meta.file_name)),
        width: meta.width,
        height: meta.height,
        cover_colors: meta.cover_colors.clone(),
    }
}

/// Decode + resize one cover and write its thumbnail JPEG. This is the
/// expensive path — it only runs when the index has no fresh entry for the
/// cover's mtime.
fn generate_one(
    cache_dir: &Path,
    book_id: &str,
    cover_path: &Path,
    mtime_ms: i64,
) -> Option<ThumbMeta> {
    let cover = image::open(cover_path).ok()?;
    let thumb = cover.resize(THUMB_WIDTH, THUMB_MAX_HEIGHT, FilterType::Triangle);

    let file_name = format!("{}-{}.jpg", book_id, mtime_ms);
    let file = fs::File::create(cache_dir.join(&file_name)).ok()?;
    let mut writer = std::io::BufWriter::new(file);
    let encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, THUMB_JPEG_QUALITY);
    // JPEG cannot carry an alpha channel; PNG covers with transparency
    // must flatten before encoding.
    thumb.to_rgb8().write_with_encoder(encoder).ok()?;

    Some(ThumbMeta {
        cover_mtime_ms: mtime_ms,
        file_name,
        width: thumb.width(),
        height: thumb.height(),
        cover_colors: Some(cover_colors(&thumb)),
    })
}

/// Returns fresh thumbnails for every source whose cover exists and decodes,
/// generating any that are missing or stale (cover mtime moved). Books whose
/// covers fail to decode are silently omitted — the grid falls back to its
/// placeholder art for those.
pub fn ensure_thumbnails(
    app_cache_dir: &Path,
    library_root: &str,
    sources: &[CoverSource],
) -> Vec<CoverThumbnail> {
    let cache_dir = thumb_cache_dir(app_cache_dir, library_root);
    if fs::create_dir_all(&cache_dir).is_err() {
        return Vec::new();
    }

    let snapshot = {
        let _guard = INDEX_LOCK.lock().expect("thumb index lock poisoned");
        load_index(&cache_dir)
    };

    // Split into cache hits and (cover, mtime) pairs needing generation.
    let mut results: Vec<CoverThumbnail> = Vec::with_capacity(sources.len());
    let mut to_generate: Vec<(&CoverSource, i64)> = Vec::new();
    for source in sources {
        let Some(mtime_ms) = cover_mtime_ms(&source.cover_path) else {
            continue; // cover.jpg is gone; has_cover flag was stale
        };
        match snapshot.get(&source.book_id) {
            Some(meta)
                if meta.cover_mtime_ms == mtime_ms
                    && meta.cover_colors.is_some()
                    && cache_dir.join(&meta.file_name).exists() =>
            {
                results.push(to_thumbnail(&source.book_id, &cache_dir, meta));
            }
            _ => to_generate.push((source, mtime_ms)),
        }
    }

    if to_generate.is_empty() {
        return results;
    }

    // Decode/resize in parallel: a first visit to a page of a big library
    // generates up to a full page of thumbnails at once.
    let workers = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4);
    let chunk_size = to_generate.len().div_ceil(workers);
    let generated: Vec<(String, ThumbMeta)> = std::thread::scope(|scope| {
        let handles: Vec<_> = to_generate
            .chunks(chunk_size)
            .map(|chunk| {
                let cache_dir = cache_dir.clone();
                scope.spawn(move || {
                    chunk
                        .iter()
                        .filter_map(|(source, mtime_ms)| {
                            generate_one(&cache_dir, &source.book_id, &source.cover_path, *mtime_ms)
                                .map(|meta| (source.book_id.clone(), meta))
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap_or_default())
            .collect()
    });

    if !generated.is_empty() {
        // Re-read under the lock: another batch may have merged meanwhile.
        let _guard = INDEX_LOCK.lock().expect("thumb index lock poisoned");
        let mut index = load_index(&cache_dir);
        for (book_id, meta) in generated {
            // Drop the previous mtime's file so replaced covers don't
            // accumulate.
            if let Some(old) = index.get(&book_id) {
                if old.file_name != meta.file_name {
                    let _ = fs::remove_file(cache_dir.join(&old.file_name));
                }
            }
            results.push(to_thumbnail(&book_id, &cache_dir, &meta));
            index.insert(book_id, meta);
        }
        store_index(&cache_dir, &index);
    }

    results
}

/// Every thumbnail already in the index, without validating cover mtimes or
/// touching cover files. This is the startup warm path: the frontend seeds
/// its thumbhash map from it so any row that mounts — at any scroll offset —
/// can paint a placeholder immediately. Entries that turn out stale are
/// corrected by the next `ensure_thumbnails` call covering them.
pub fn list_thumbnails(app_cache_dir: &Path, library_root: &str) -> Vec<CoverThumbnail> {
    let cache_dir = thumb_cache_dir(app_cache_dir, library_root);
    let index = {
        let _guard = INDEX_LOCK.lock().expect("thumb index lock poisoned");
        load_index(&cache_dir)
    };
    index
        .iter()
        .map(|(book_id, meta)| to_thumbnail(book_id, &cache_dir, meta))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn write_test_cover(dir: &Path, name: &str, width: u32, height: u32) -> PathBuf {
        let mut img = RgbImage::new(width, height);
        for (x, y, pixel) in img.enumerate_pixels_mut() {
            *pixel = Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
        }
        let path = dir.join(name);
        img.save(&path).expect("write test cover");
        path
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "citadel-thumb-test-{}-{}",
            label,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn generates_thumbnail_with_hash_and_dimensions() {
        let dir = temp_dir("generate");
        let cover = write_test_cover(&dir, "cover.jpg", 1200, 1800);

        let thumbs = ensure_thumbnails(
            &dir,
            "/library",
            &[CoverSource {
                book_id: "1".into(),
                cover_path: cover,
            }],
        );

        assert_eq!(thumbs.len(), 1);
        let thumb = &thumbs[0];
        assert_eq!(thumb.book_id, "1");
        assert_eq!(thumb.width, 300);
        assert_eq!(thumb.height, 450);
        assert!(thumb.url.contains("asset"));
        assert!(thumb.cover_colors.is_some());

        let cache_dir = thumb_cache_dir(&dir, "/library");
        assert!(index_path(&cache_dir).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_call_is_a_cache_hit() {
        let dir = temp_dir("cache-hit");
        let cover = write_test_cover(&dir, "cover.jpg", 600, 900);
        let source = || {
            vec![CoverSource {
                book_id: "2".into(),
                cover_path: cover.clone(),
            }]
        };

        let first = ensure_thumbnails(&dir, "/library", &source());
        let cache_dir = thumb_cache_dir(&dir, "/library");
        let thumb_file = cache_dir.join(
            first[0]
                .url
                .rsplit("%2F")
                .next()
                .map(|s| urlencoding::decode(s).unwrap().into_owned())
                .unwrap(),
        );
        let first_written = fs::metadata(&thumb_file).unwrap().modified().unwrap();

        let second = ensure_thumbnails(&dir, "/library", &source());
        assert_eq!(second[0].url, first[0].url);
        let second_written = fs::metadata(&thumb_file).unwrap().modified().unwrap();
        assert_eq!(first_written, second_written, "thumbnail was regenerated");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_returns_indexed_thumbnails_without_touching_covers() {
        let dir = temp_dir("list");
        assert!(list_thumbnails(&dir, "/library").is_empty());

        let cover = write_test_cover(&dir, "cover.jpg", 600, 900);
        let generated = ensure_thumbnails(
            &dir,
            "/library",
            &[CoverSource {
                book_id: "7".into(),
                cover_path: cover.clone(),
            }],
        );

        // Listing works even after the cover file is gone (index-only read).
        fs::remove_file(&cover).unwrap();
        let listed = list_thumbnails(&dir, "/library");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].book_id, "7");
        assert_eq!(listed[0].url, generated[0].url);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_cover_is_omitted() {
        let dir = temp_dir("missing");
        let thumbs = ensure_thumbnails(
            &dir,
            "/library",
            &[CoverSource {
                book_id: "3".into(),
                cover_path: dir.join("nope.jpg"),
            }],
        );
        assert!(thumbs.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
