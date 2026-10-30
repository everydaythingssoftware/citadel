//! Provider cover art, fetched by Citadel so browsers and webviews never
//! contact provider hosts and never hand Citadel a URL to fetch (ADR 0010).
//! Lookups register each result's image under an opaque cover ID; previews
//! and "apply" name only that ID. Fetches go only to the provider's own
//! image hosts over HTTPS, are size- and time-capped, and every image is
//! decoded within limits and re-encoded before anything keeps it.
use std::{
    collections::{HashMap, VecDeque},
    io::Cursor,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, ImageReader, Limits};
use reqwest::Url;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use crate::{
    error::{MetadataError, MetadataErrorKind},
    model::{BookMetadata, MetadataProvider},
};

const MIB: u64 = 1024 * 1024;
/// A registered cover stays resolvable this long after it was last seen in
/// a lookup or used.
const REGISTRY_IDLE: Duration = Duration::from_secs(60 * 60);
const REGISTRY_MAX: usize = 8192;
const MAX_REDIRECTS: usize = 3;
const MAX_DIMENSION: u32 = 10_000;
const DECODE_ALLOC_BYTES: u64 = 64 * MIB;
const SLOT_WAIT: Duration = Duration::from_secs(5);

/// Limits for cover fetching and the in-memory image cache.
#[derive(Clone, Debug)]
pub struct CoverOptions {
    pub max_image_bytes: u64,
    pub fetch_timeout: Duration,
    pub max_concurrent_fetches: usize,
    /// Shared by previews and prefetched full-size images.
    pub cache_bytes: usize,
    pub preview_ttl: Duration,
    pub preview_long_edge: u32,
    /// How long a prefetched full-size image waits for "apply".
    pub prefetch_ttl: Duration,
}

impl Default for CoverOptions {
    fn default() -> Self {
        Self {
            max_image_bytes: 15 * MIB,
            fetch_timeout: Duration::from_secs(15),
            max_concurrent_fetches: 8,
            cache_bytes: 32 * MIB as usize,
            preview_ttl: Duration::from_secs(180),
            preview_long_edge: 600,
            prefetch_ttl: Duration::from_secs(60),
        }
    }
}

/// Which hosts a provider's images may come from, redirects included.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostRule {
    Exact(String),
    /// The domain and its subdomains.
    Domain(String),
}

impl HostRule {
    fn matches(&self, host: &str) -> bool {
        match self {
            Self::Exact(exact) => host.eq_ignore_ascii_case(exact),
            Self::Domain(domain) => {
                host.eq_ignore_ascii_case(domain)
                    || host
                        .to_ascii_lowercase()
                        .ends_with(&format!(".{}", domain.to_ascii_lowercase()))
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct CoverPolicy {
    pub hosts: Vec<(MetadataProvider, HostRule)>,
    pub https_only: bool,
}

impl Default for CoverPolicy {
    fn default() -> Self {
        Self {
            hosts: vec![
                // Open Library redirects cover-by-ID requests to Internet
                // Archive storage nodes (iaNNNN.us.archive.org).
                (
                    MetadataProvider::OpenLibrary,
                    HostRule::Exact("covers.openlibrary.org".into()),
                ),
                (
                    MetadataProvider::OpenLibrary,
                    HostRule::Domain("archive.org".into()),
                ),
                (
                    MetadataProvider::Hardcover,
                    HostRule::Exact("assets.hardcover.app".into()),
                ),
            ],
            https_only: true,
        }
    }
}

impl CoverPolicy {
    fn allows(&self, provider: MetadataProvider, url: &Url) -> bool {
        let scheme_ok = url.scheme() == "https" || (!self.https_only && url.scheme() == "http");
        let Some(host) = url.host_str() else {
            return false;
        };
        scheme_ok
            && url.username().is_empty()
            && url.password().is_none()
            && self
                .hosts
                .iter()
                .any(|(owner, rule)| *owner == provider && rule.matches(host))
    }
}

pub(crate) struct Covers {
    http: reqwest::Client,
    policy: CoverPolicy,
    options: CoverOptions,
    slots: Semaphore,
    registry: Mutex<Registry>,
    cache: Mutex<ByteCache>,
}

impl Covers {
    pub fn new(
        user_agent: &str,
        policy: CoverPolicy,
        options: CoverOptions,
    ) -> Result<Self, MetadataError> {
        // Redirects are followed by hand so every hop is checked.
        let http = reqwest::Client::builder()
            .user_agent(user_agent)
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| MetadataError::upstream(format!("Failed to build HTTP client: {e}")))?;
        Ok(Self {
            http,
            slots: Semaphore::new(options.max_concurrent_fetches.max(1)),
            policy,
            options,
            registry: Mutex::default(),
            cache: Mutex::default(),
        })
    }

    /// Give each result with an allowed image a cover ID. Run on every
    /// lookup, cached or not, so IDs stay resolvable while results are shown.
    pub fn register(&self, books: &mut [BookMetadata]) {
        let now = Instant::now();
        let mut registry = lock(&self.registry);
        for book in books {
            book.cover_id = book
                .image_url
                .as_deref()
                .and_then(|url| Url::parse(url).ok())
                .filter(|url| self.policy.allows(book.provider, url))
                .map(|url| registry.register(book.provider, url, now));
        }
    }

    pub async fn preview(&self, cover_id: &str) -> Result<Arc<Vec<u8>>, MetadataError> {
        let key = format!("preview:{cover_id}");
        if let Some(bytes) = lock(&self.cache).get(&key, Instant::now()) {
            return Ok(bytes);
        }
        let (provider, url) = self.resolve(cover_id)?;
        let original = self.download(provider, url).await?;
        let long_edge = self.options.preview_long_edge;
        let bytes = Arc::new(reencode(original, Some(long_edge)).await?);
        lock(&self.cache).insert(
            key,
            bytes.clone(),
            self.options.preview_ttl,
            self.options.cache_bytes,
            Instant::now(),
        );
        Ok(bytes)
    }

    /// Fetch the full-size image ahead of "apply", once the user picks it.
    pub async fn prefetch(&self, cover_id: &str) -> Result<(), MetadataError> {
        self.full(cover_id).await.map(|_| ())
    }

    /// The full-size image as a JPEG, ready to store as a book cover.
    pub async fn full(&self, cover_id: &str) -> Result<Arc<Vec<u8>>, MetadataError> {
        let key = format!("full:{cover_id}");
        if let Some(bytes) = lock(&self.cache).get(&key, Instant::now()) {
            return Ok(bytes);
        }
        let (provider, url) = self.resolve(cover_id)?;
        let original = self.download(provider, url).await?;
        let bytes = Arc::new(reencode(original, None).await?);
        lock(&self.cache).insert(
            key,
            bytes.clone(),
            self.options.prefetch_ttl,
            self.options.cache_bytes,
            Instant::now(),
        );
        Ok(bytes)
    }

    fn resolve(&self, cover_id: &str) -> Result<(MetadataProvider, Url), MetadataError> {
        lock(&self.registry)
            .resolve(cover_id, Instant::now())
            .ok_or_else(|| {
                MetadataError::new(
                    MetadataErrorKind::Gone,
                    "This cover is no longer available — search again.",
                )
            })
    }

    async fn download(
        &self,
        provider: MetadataProvider,
        url: Url,
    ) -> Result<Vec<u8>, MetadataError> {
        let _slot = tokio::time::timeout(SLOT_WAIT, self.slots.acquire())
            .await
            .map_err(|_| MetadataError::rate_limited(Duration::from_secs(1)))?
            .map_err(|_| MetadataError::rate_limited(Duration::from_secs(1)))?;
        tokio::time::timeout(self.options.fetch_timeout, self.follow(provider, url))
            .await
            .map_err(|_| MetadataError::upstream("The cover took too long to download."))?
    }

    async fn follow(
        &self,
        provider: MetadataProvider,
        mut url: Url,
    ) -> Result<Vec<u8>, MetadataError> {
        for _ in 0..=MAX_REDIRECTS {
            if !self.policy.allows(provider, &url) {
                return Err(MetadataError::upstream(
                    "The provider sent the cover from a host Citadel doesn't fetch from.",
                ));
            }
            let mut response = self
                .http
                .get(url.clone())
                .send()
                .await
                .map_err(|_| MetadataError::upstream("Failed to download the cover."))?;
            let status = response.status();
            if status.is_redirection() {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| MetadataError::upstream("The cover redirect had no target."))?;
                url = url
                    .join(location)
                    .map_err(|_| MetadataError::upstream("The cover redirect was invalid."))?;
                continue;
            }
            if !status.is_success() {
                return Err(MetadataError::upstream(format!(
                    "The cover request returned status {status}"
                )));
            }
            let is_image = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_none_or(|value| value.trim().to_ascii_lowercase().starts_with("image/"));
            if !is_image {
                return Err(MetadataError::upstream(
                    "The provider didn't send an image.",
                ));
            }
            let max = self.options.max_image_bytes;
            if response.content_length().is_some_and(|length| length > max) {
                return Err(too_large(max));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| MetadataError::upstream("Failed to download the cover."))?
            {
                if bytes.len() as u64 + chunk.len() as u64 > max {
                    return Err(too_large(max));
                }
                bytes.extend_from_slice(&chunk);
            }
            return Ok(bytes);
        }
        Err(MetadataError::upstream(
            "The cover redirected too many times.",
        ))
    }
}

fn too_large(max: u64) -> MetadataError {
    MetadataError::new(
        MetadataErrorKind::TooLarge,
        format!("The cover is larger than {} MiB.", max / MIB),
    )
}

/// Decode an untrusted image within limits and re-encode it as JPEG, scaled
/// to fit `long_edge` when given.
pub async fn reencode(bytes: Vec<u8>, long_edge: Option<u32>) -> Result<Vec<u8>, MetadataError> {
    tokio::task::spawn_blocking(move || reencode_blocking(&bytes, long_edge))
        .await
        .map_err(|_| MetadataError::upstream("Could not read the cover image."))?
}

fn reencode_blocking(bytes: &[u8], long_edge: Option<u32>) -> Result<Vec<u8>, MetadataError> {
    let unreadable = || MetadataError::invalid("That isn't an image Citadel can read.");
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| unreadable())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(DECODE_ALLOC_BYTES);
    reader.limits(limits);
    let mut image = reader.decode().map_err(|_| unreadable())?;
    if let Some(edge) = long_edge {
        if image.width() > edge || image.height() > edge {
            image = image.resize(edge, edge, FilterType::Triangle);
        }
    }
    let rgb = image.to_rgb8();
    let quality = if long_edge.is_some() { 80 } else { 90 };
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, quality)
        .encode_image(&rgb)
        .map_err(|_| unreadable())?;
    Ok(out)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn cover_id(url: &Url) -> String {
    Sha256::digest(url.as_str().as_bytes())[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Default)]
struct Registry {
    entries: HashMap<String, Registered>,
}

struct Registered {
    provider: MetadataProvider,
    url: Url,
    used: Instant,
}

impl Registry {
    fn register(&mut self, provider: MetadataProvider, url: Url, now: Instant) -> String {
        let id = cover_id(&url);
        if self.entries.len() >= REGISTRY_MAX && !self.entries.contains_key(&id) {
            self.entries
                .retain(|_, entry| now.saturating_duration_since(entry.used) < REGISTRY_IDLE);
            if self.entries.len() >= REGISTRY_MAX {
                if let Some(oldest) = self
                    .entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.used)
                    .map(|(id, _)| id.clone())
                {
                    self.entries.remove(&oldest);
                }
            }
        }
        self.entries.insert(
            id.clone(),
            Registered {
                provider,
                url,
                used: now,
            },
        );
        id
    }

    fn resolve(&mut self, id: &str, now: Instant) -> Option<(MetadataProvider, Url)> {
        let entry = self.entries.get_mut(id)?;
        if now.saturating_duration_since(entry.used) >= REGISTRY_IDLE {
            self.entries.remove(id);
            return None;
        }
        entry.used = now;
        Some((entry.provider, entry.url.clone()))
    }
}

/// Recently made images under one byte budget; the oldest go first.
#[derive(Default)]
struct ByteCache {
    entries: HashMap<String, (Arc<Vec<u8>>, Instant)>,
    order: VecDeque<String>,
    bytes: usize,
}

impl ByteCache {
    fn get(&mut self, key: &str, now: Instant) -> Option<Arc<Vec<u8>>> {
        let (bytes, expires) = self.entries.get(key)?;
        if *expires > now {
            return Some(bytes.clone());
        }
        self.remove(key);
        None
    }

    fn insert(
        &mut self,
        key: String,
        bytes: Arc<Vec<u8>>,
        ttl: Duration,
        budget: usize,
        now: Instant,
    ) {
        self.remove(&key);
        if bytes.len() > budget / 2 {
            return;
        }
        while self.bytes + bytes.len() > budget {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some((evicted, _)) = self.entries.remove(&oldest) {
                self.bytes -= evicted.len();
            }
        }
        self.bytes += bytes.len();
        self.order.push_back(key.clone());
        self.entries.insert(key, (bytes, now + ttl));
    }

    fn remove(&mut self, key: &str) {
        if let Some((bytes, _)) = self.entries.remove(key) {
            self.bytes -= bytes.len();
            self.order.retain(|queued| queued != key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    pub(crate) fn jpeg(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbImage::from_pixel(width, height, image::Rgb([200, 40, 40]));
        let mut bytes = Vec::new();
        JpegEncoder::new(&mut bytes).encode_image(&image).unwrap();
        bytes
    }

    #[test]
    fn default_policy_allows_only_provider_image_hosts_over_https() {
        let policy = CoverPolicy::default();
        let open_library = MetadataProvider::OpenLibrary;
        for allowed in [
            "https://covers.openlibrary.org/b/id/1-L.jpg",
            "https://archive.org/download/m_covers/1-L.jpg",
            "https://ia800100.us.archive.org/view_archive.php?file=1-L.jpg",
        ] {
            assert!(policy.allows(open_library, &url(allowed)), "{allowed}");
        }
        for refused in [
            "http://covers.openlibrary.org/b/id/1-L.jpg",
            "https://covers.openlibrary.org.evil.example/1.jpg",
            "https://notarchive.org/1.jpg",
            "https://user:pass@covers.openlibrary.org/1.jpg",
            "https://127.0.0.1/1.jpg",
            "https://assets.hardcover.app/1.jpg",
        ] {
            assert!(!policy.allows(open_library, &url(refused)), "{refused}");
        }
        assert!(policy.allows(
            MetadataProvider::Hardcover,
            &url("https://assets.hardcover.app/edition/1/x.jpeg")
        ));
        assert!(!policy.allows(
            MetadataProvider::Loc,
            &url("https://covers.openlibrary.org/b/id/1-L.jpg")
        ));
    }

    #[test]
    fn registry_ids_are_stable_and_expire_when_idle() {
        let now = Instant::now();
        let mut registry = Registry::default();
        let cover = url("https://covers.openlibrary.org/b/id/1-L.jpg");
        let id = registry.register(MetadataProvider::OpenLibrary, cover.clone(), now);
        assert_eq!(id.len(), 32);
        assert_eq!(
            registry.register(MetadataProvider::OpenLibrary, cover.clone(), now),
            id
        );
        let later = now + REGISTRY_IDLE - Duration::from_secs(1);
        assert_eq!(registry.resolve(&id, later).unwrap().1, cover);
        // Using it refreshes it.
        assert!(registry.resolve(&id, later + REGISTRY_IDLE / 2).is_some());
        assert!(registry.resolve(&id, later + REGISTRY_IDLE * 2).is_none());
        assert!(registry.resolve("unknown", now).is_none());
    }

    #[test]
    fn untrusted_images_are_decoded_within_limits_and_reencoded() {
        let preview = reencode_blocking(&jpeg(1200, 1800), Some(600)).unwrap();
        let decoded = image::load_from_memory(&preview).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (400, 600));
        let full = reencode_blocking(&jpeg(300, 450), None).unwrap();
        let decoded = image::load_from_memory(&full).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (300, 450));

        assert_eq!(
            reencode_blocking(b"<html>not an image</html>", None)
                .unwrap_err()
                .kind,
            MetadataErrorKind::InvalidArgument
        );
        // A tiny PNG claiming to be 20000 px wide is refused before decoding.
        let mut huge = Vec::new();
        image::codecs::png::PngEncoder::new(&mut huge)
            .write_image(&[0; 3], 1, 1, image::ExtendedColorType::Rgb8)
            .unwrap();
        huge[16..20].copy_from_slice(&20_000u32.to_be_bytes());
        assert!(reencode_blocking(&huge, None).is_err());
    }

    #[test]
    fn cache_respects_ttl_and_byte_budget() {
        let now = Instant::now();
        let ttl = Duration::from_secs(10);
        let mut cache = ByteCache::default();
        for key in ["a", "b", "c"] {
            cache.insert(key.into(), Arc::new(vec![0; 40]), ttl, 100, now);
        }
        assert!(cache.bytes <= 100);
        assert!(cache.get("a", now).is_none());
        assert!(cache.get("c", now).is_some());
        assert!(cache.get("c", now + ttl).is_none());
        cache.insert("big".into(), Arc::new(vec![0; 60]), ttl, 100, now);
        assert!(cache.get("big", now).is_none());
    }

    use image::ImageEncoder;
}
