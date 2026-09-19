use std::{io::Read, sync::Arc};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use bytes::Bytes;
use chrono::{NaiveDateTime, SecondsFormat};
use libcalibre::{
    AuthorId, BookId, BookPage, BookQuery, BookSortOrder, CalibreError, ResolvedBookAsset,
};
use serde::Deserialize;

use super::{
    assets::{self, AssetMethod, AssetResponseError},
    auth::{require_basic_auth, OpdsBasicAuth},
};
use crate::identity::{book_identity, library_identity, navigation_identity};

const PAGE_SIZE: u64 = 50;
const MAX_SEARCH_LENGTH: usize = 200;
const ACQUISITION_REL: &str = "http://opds-spec.org/acquisition";
pub(crate) const IMAGE_REL: &str = "http://opds-spec.org/image";
const ATOM_TYPE: &str = "application/atom+xml;profile=opds-catalog;kind=acquisition";
const ATOM_CONTENT_TYPE: &str =
    "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8";
const NAVIGATION_TYPE: &str = "application/atom+xml;profile=opds-catalog;kind=navigation";
const NAVIGATION_CONTENT_TYPE: &str =
    "application/atom+xml;profile=opds-catalog;kind=navigation; charset=utf-8";
const OPENSEARCH_TYPE: &str = "application/opensearchdescription+xml";
pub(crate) const IMAGE_TYPE: &str = "image/jpeg";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CatalogFilter {
    All,
    Unread,
    Author(i32),
    Series(i32),
    Tag(i32),
    Genre(i32),
    Search(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CatalogSort {
    Title,
    Updated,
    SeriesIndex,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogBookQuery {
    pub filter: CatalogFilter,
    pub sort: CatalogSort,
    pub limit: i64,
    pub offset: i64,
}

impl CatalogBookQuery {
    /// Translate the protocol query into libcalibre's bounded query contract.
    pub fn into_calibre(self) -> BookQuery {
        let mut query = BookQuery {
            limit: Some(self.limit),
            offset: self.offset,
            sort: match self.sort {
                CatalogSort::Title => BookSortOrder::TitleAsc,
                CatalogSort::Updated => BookSortOrder::UpdatedDesc,
                CatalogSort::SeriesIndex => BookSortOrder::SeriesIndexAsc,
            },
            ..BookQuery::default()
        };
        match self.filter {
            CatalogFilter::All => {}
            CatalogFilter::Unread => query.hide_read = true,
            CatalogFilter::Author(id) => query.author_id = Some(AuthorId(id)),
            CatalogFilter::Series(id) => query.series_id = Some(id),
            CatalogFilter::Tag(id) => query.tag_id = Some(id),
            CatalogFilter::Genre(id) => query.genre_id = Some(id),
            CatalogFilter::Search(text) => query.text = Some(text),
        }
        query
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogFacet {
    pub id: i32,
    pub title: String,
    pub book_count: Option<i64>,
}

pub trait CatalogSource: Send + Sync + 'static {
    fn active_library_id(&self) -> Result<String, CalibreError>;

    fn book_page(
        &self,
        query: CatalogBookQuery,
    ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError>;
    fn authors(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        Ok(Vec::new())
    }
    fn series(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        Ok(Vec::new())
    }
    fn tags(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        Ok(Vec::new())
    }
    fn genres(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
        Ok(Vec::new())
    }
    fn book_file(&self, book_id: BookId, format: &str) -> Result<ResolvedBookAsset, CalibreError>;
    fn book_cover(&self, book_id: BookId) -> Result<ResolvedBookAsset, CalibreError>;
}

#[derive(Clone)]
struct CatalogState {
    source: Arc<dyn CatalogSource>,
}

#[derive(Deserialize)]
struct PageQuery {
    page: Option<u64>,
}

pub(crate) struct Feed {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) updated: String,
    pub(crate) links: Vec<FeedLink>,
    pub(crate) entries: Vec<FeedEntry>,
}

pub(crate) struct FeedLink {
    pub(crate) rel: &'static str,
    pub(crate) href: String,
    pub(crate) media_type: &'static str,
}

pub(crate) struct FeedEntry {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) updated: String,
    pub(crate) authors: Vec<String>,
    pub(crate) published: String,
    pub(crate) languages: Vec<String>,
    pub(crate) identifiers: Vec<String>,
    pub(crate) categories: Vec<String>,
    pub(crate) acquisition_links: Vec<(String, String, String)>,
    pub(crate) image_link: Option<String>,
    pub(crate) content: Option<String>,
}

pub fn router(source: Arc<dyn CatalogSource>, auth: OpdsBasicAuth) -> Router {
    Router::new()
        .route("/opds", get(root_feed))
        .route("/opds/all", get(all_books_feed))
        .route("/opds/recent", get(recent_books_feed))
        .route("/opds/unread", get(unread_books_feed))
        .route("/opds/authors", get(authors_feed))
        .route("/opds/authors/{id}", get(author_books_feed))
        .route("/opds/series", get(series_feed))
        .route("/opds/series/{id}", get(series_books_feed))
        .route("/opds/tags", get(tags_feed))
        .route("/opds/tags/{id}", get(tag_books_feed))
        .route("/opds/genres", get(genres_feed))
        .route("/opds/genres/{id}", get(genre_books_feed))
        .route("/opds/search", get(search_feed))
        .route("/opds/opensearch.xml", get(opensearch_description))
        .route(
            "/opds/books/{book_id}/files/{format}/{filename}",
            get(book_file).head(book_file_head),
        )
        .route(
            "/opds/books/{book_id}/cover",
            get(book_cover).head(book_cover_head),
        )
        .with_state(CatalogState { source })
        .layer(axum::middleware::from_fn_with_state(
            auth,
            require_basic_auth,
        ))
}

async fn root_feed(state: State<CatalogState>, query: Query<PageQuery>) -> Response {
    if query.page.unwrap_or(1) != 1 {
        return public_error(StatusCode::NOT_FOUND, "Page not found");
    }
    let source = state.source.clone();
    let library_uuid = match tokio::task::spawn_blocking(move || source.active_library_id()).await {
        Ok(Ok(uuid)) => uuid,
        Ok(Err(error)) => return calibre_error(error),
        Err(_) => return public_error(StatusCode::INTERNAL_SERVER_ERROR, "Catalog unavailable"),
    };
    match root_navigation_feed(&library_uuid) {
        Ok(xml) => xml_response(NAVIGATION_CONTENT_TYPE, xml),
        Err(_) => public_error(StatusCode::INTERNAL_SERVER_ERROR, "Catalog unavailable"),
    }
}

async fn all_books_feed(state: State<CatalogState>, query: Query<PageQuery>) -> Response {
    acquisition_handler(
        state,
        query.0,
        CatalogFilter::All,
        CatalogSort::Title,
        "/opds/all",
        "All Books",
    )
    .await
}

async fn recent_books_feed(state: State<CatalogState>, query: Query<PageQuery>) -> Response {
    acquisition_handler(
        state,
        query.0,
        CatalogFilter::All,
        CatalogSort::Updated,
        "/opds/recent",
        "Recently Modified",
    )
    .await
}

async fn unread_books_feed(state: State<CatalogState>, query: Query<PageQuery>) -> Response {
    acquisition_handler(
        state,
        query.0,
        CatalogFilter::Unread,
        CatalogSort::Title,
        "/opds/unread",
        "Unread",
    )
    .await
}

async fn author_books_feed(
    state: State<CatalogState>,
    Path(id): Path<i32>,
    query: Query<PageQuery>,
) -> Response {
    acquisition_handler(
        state,
        query.0,
        CatalogFilter::Author(id),
        CatalogSort::Title,
        &format!("/opds/authors/{id}"),
        "Books by Author",
    )
    .await
}

async fn series_books_feed(
    state: State<CatalogState>,
    Path(id): Path<i32>,
    query: Query<PageQuery>,
) -> Response {
    acquisition_handler(
        state,
        query.0,
        CatalogFilter::Series(id),
        CatalogSort::SeriesIndex,
        &format!("/opds/series/{id}"),
        "Books in Series",
    )
    .await
}

async fn tag_books_feed(
    state: State<CatalogState>,
    Path(id): Path<i32>,
    query: Query<PageQuery>,
) -> Response {
    acquisition_handler(
        state,
        query.0,
        CatalogFilter::Tag(id),
        CatalogSort::Title,
        &format!("/opds/tags/{id}"),
        "Books by Tag",
    )
    .await
}

async fn genre_books_feed(
    state: State<CatalogState>,
    Path(id): Path<i32>,
    query: Query<PageQuery>,
) -> Response {
    acquisition_handler(
        state,
        query.0,
        CatalogFilter::Genre(id),
        CatalogSort::Title,
        &format!("/opds/genres/{id}"),
        "Books by Genre",
    )
    .await
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    page: Option<u64>,
}

async fn search_feed(state: State<CatalogState>, Query(query): Query<SearchQuery>) -> Response {
    let text = query.q.unwrap_or_default();
    let text = text.trim();
    if text.is_empty() {
        return public_error(StatusCode::BAD_REQUEST, "Search query is required");
    }
    if text.chars().count() > MAX_SEARCH_LENGTH {
        return public_error(StatusCode::BAD_REQUEST, "Search query is too long");
    }
    let route = format!("/opds/search?q={}", urlencoding::encode(text));
    acquisition_handler(
        state,
        PageQuery { page: query.page },
        CatalogFilter::Search(text.to_string()),
        CatalogSort::Title,
        &route,
        "Search Results",
    )
    .await
}

async fn authors_feed(state: State<CatalogState>) -> Response {
    facet_handler(state, CatalogFacetKind::Authors).await
}

async fn series_feed(state: State<CatalogState>) -> Response {
    facet_handler(state, CatalogFacetKind::Series).await
}

async fn tags_feed(state: State<CatalogState>) -> Response {
    facet_handler(state, CatalogFacetKind::Tags).await
}

async fn genres_feed(state: State<CatalogState>) -> Response {
    facet_handler(state, CatalogFacetKind::Genres).await
}

async fn opensearch_description() -> Response {
    xml_response(OPENSEARCH_TYPE, opensearch_xml())
}

async fn acquisition_handler(
    State(state): State<CatalogState>,
    query: PageQuery,
    filter: CatalogFilter,
    sort: CatalogSort,
    route: &str,
    title: &str,
) -> Response {
    let (page_number, offset) = match page_params(&query) {
        Ok(params) => params,
        Err(response) => return response,
    };

    let source = state.source.clone();
    let result = tokio::task::spawn_blocking(move || {
        source.book_page(CatalogBookQuery {
            filter,
            sort,
            limit: PAGE_SIZE as i64,
            offset,
        })
    })
    .await;
    let (library_uuid, updated_at, page) = match result {
        Ok(Ok(page)) => page,
        Ok(Err(error)) => return calibre_error(error),
        Err(_) => return public_error(StatusCode::INTERNAL_SERVER_ERROR, "Catalog unavailable"),
    };

    let last_page = page_count(page.total).max(1);
    if page_number > last_page {
        return public_error(StatusCode::NOT_FOUND, "Page not found");
    }

    match acquisition_feed(
        &library_uuid,
        updated_at,
        &page,
        page_number,
        last_page,
        route,
        title,
    ) {
        Ok(xml) => (
            [(
                header::CONTENT_TYPE,
                HeaderValue::from_static(ATOM_CONTENT_TYPE),
            )],
            xml,
        )
            .into_response(),
        Err(_) => public_error(StatusCode::INTERNAL_SERVER_ERROR, "Catalog unavailable"),
    }
}

#[derive(Clone, Copy)]
enum CatalogFacetKind {
    Authors,
    Series,
    Tags,
    Genres,
}

impl CatalogFacetKind {
    fn title(self) -> &'static str {
        match self {
            Self::Authors => "Authors",
            Self::Series => "Series",
            Self::Tags => "Tags",
            Self::Genres => "Genres",
        }
    }

    fn route(self) -> &'static str {
        match self {
            Self::Authors => "/opds/authors",
            Self::Series => "/opds/series",
            Self::Tags => "/opds/tags",
            Self::Genres => "/opds/genres",
        }
    }
}

async fn facet_handler(State(state): State<CatalogState>, kind: CatalogFacetKind) -> Response {
    let source = state.source.clone();
    let result = tokio::task::spawn_blocking(move || {
        let library_uuid = source.active_library_id()?;
        let facets = match kind {
            CatalogFacetKind::Authors => source.authors()?,
            CatalogFacetKind::Series => source.series()?,
            CatalogFacetKind::Tags => source.tags()?,
            CatalogFacetKind::Genres => source.genres()?,
        };
        Ok::<_, CalibreError>((library_uuid, facets))
    })
    .await;
    let (library_uuid, facets) = match result {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => return calibre_error(error),
        Err(_) => return public_error(StatusCode::INTERNAL_SERVER_ERROR, "Catalog unavailable"),
    };
    match facet_navigation_feed(&library_uuid, kind, &facets) {
        Ok(xml) => xml_response(NAVIGATION_CONTENT_TYPE, xml),
        Err(_) => public_error(StatusCode::INTERNAL_SERVER_ERROR, "Catalog unavailable"),
    }
}

fn xml_response(content_type: &'static str, xml: Vec<u8>) -> Response {
    ([(header::CONTENT_TYPE, content_type)], xml).into_response()
}

fn page_params(query: &PageQuery) -> Result<(u64, i64), Response> {
    let page_number = query.page.unwrap_or(1);
    if page_number == 0 {
        return Err(public_error(StatusCode::BAD_REQUEST, "Invalid page"));
    }
    let offset = match page_number
        .checked_sub(1)
        .and_then(|page| page.checked_mul(PAGE_SIZE))
        .and_then(|offset| i64::try_from(offset).ok())
    {
        Some(offset) => offset,
        None => return Err(public_error(StatusCode::BAD_REQUEST, "Invalid page")),
    };
    Ok((page_number, offset))
}

async fn book_file(
    state: State<CatalogState>,
    Path((book_id, format, _filename)): Path<(i32, String, String)>,
    headers: axum::http::HeaderMap,
) -> Response {
    asset_response(
        state,
        BookId(book_id),
        Some(format),
        AssetMethod::Get,
        headers,
    )
    .await
}

async fn book_file_head(
    state: State<CatalogState>,
    Path((book_id, format, _filename)): Path<(i32, String, String)>,
    headers: axum::http::HeaderMap,
) -> Response {
    asset_response(
        state,
        BookId(book_id),
        Some(format),
        AssetMethod::Head,
        headers,
    )
    .await
}

async fn book_cover(
    state: State<CatalogState>,
    Path(book_id): Path<i32>,
    headers: axum::http::HeaderMap,
) -> Response {
    asset_response(state, BookId(book_id), None, AssetMethod::Get, headers).await
}

async fn book_cover_head(
    state: State<CatalogState>,
    Path(book_id): Path<i32>,
    headers: axum::http::HeaderMap,
) -> Response {
    asset_response(state, BookId(book_id), None, AssetMethod::Head, headers).await
}

async fn asset_response(
    State(state): State<CatalogState>,
    book_id: BookId,
    format: Option<String>,
    method: AssetMethod,
    headers: axum::http::HeaderMap,
) -> Response {
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);

    let asset = match resolve_asset(state.source.clone(), book_id, format).await {
        Ok(Ok(asset)) => asset,
        Ok(Err(error)) => return calibre_error(error),
        Err(_) => return public_error(StatusCode::INTERNAL_SERVER_ERROR, "Asset unavailable"),
    };

    let prepared =
        tokio::task::spawn_blocking(move || assets::prepare(&asset, method, range.as_deref()))
            .await;
    let prepared = match prepared {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => return asset_error_response(error),
        Err(_) => return public_error(StatusCode::INTERNAL_SERVER_ERROR, "Asset unavailable"),
    };

    let mut builder = Response::builder()
        .status(prepared.status)
        .header(header::ACCEPT_RANGES, prepared.headers.accept_ranges)
        .header(
            header::CONTENT_DISPOSITION,
            prepared.headers.content_disposition,
        )
        .header(header::CONTENT_LENGTH, prepared.headers.content_length)
        .header(header::CONTENT_TYPE, prepared.headers.content_type);
    if let Some(content_range) = prepared.headers.content_range {
        builder = builder.header(header::CONTENT_RANGE, content_range);
    }

    let body = match prepared.body {
        Some(reader) => stream_body(reader),
        None => Body::empty(),
    };
    builder
        .body(body)
        .unwrap_or_else(|_| public_error(StatusCode::INTERNAL_SERVER_ERROR, "Asset unavailable"))
}

async fn resolve_asset(
    source: Arc<dyn CatalogSource>,
    book_id: BookId,
    format: Option<String>,
) -> Result<Result<ResolvedBookAsset, CalibreError>, tokio::task::JoinError> {
    tokio::task::spawn_blocking(move || match format {
        Some(format) => source.book_file(book_id, &format),
        None => source.book_cover(book_id),
    })
    .await
}

fn asset_error_response(error: AssetResponseError) -> Response {
    let mut response = public_error(
        StatusCode::from_u16(error.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        if error.status() == 416 {
            "Range not satisfiable"
        } else {
            "Asset unavailable"
        },
    );
    if let Some(content_range) = error.content_range() {
        if let Ok(value) = HeaderValue::from_str(&content_range) {
            response.headers_mut().insert(header::CONTENT_RANGE, value);
        }
    }
    response
}

fn stream_body(reader: assets::AssetBody) -> Body {
    let (sender, receiver) = tokio::sync::mpsc::channel(2);
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        loop {
            let mut buffer = vec![0_u8; 64 * 1024];
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    buffer.truncate(read);
                    if sender
                        .blocking_send(Ok::<_, std::io::Error>(Bytes::from(buffer)))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.blocking_send(Err(error));
                    break;
                }
            }
        }
    });
    Body::from_stream(futures_util::stream::unfold(
        receiver,
        |mut receiver| async move { receiver.recv().await.map(|item| (item, receiver)) },
    ))
}

fn acquisition_feed(
    library_uuid: &str,
    updated_at: Option<NaiveDateTime>,
    page: &BookPage,
    page_number: u64,
    last_page: u64,
    route: &str,
    title: &str,
) -> Result<Vec<u8>, quick_xml::Error> {
    let mut links = vec![
        FeedLink {
            rel: "self",
            href: page_href(route, page_number),
            media_type: ATOM_TYPE,
        },
        FeedLink {
            rel: "start",
            href: "/opds".to_string(),
            media_type: ATOM_TYPE,
        },
    ];
    if route != "/opds" {
        links.push(FeedLink {
            rel: "up",
            href: "/opds".to_string(),
            media_type: ATOM_TYPE,
        });
    }
    if page_number > 1 {
        links.push(FeedLink {
            rel: "previous",
            href: page_href(route, page_number - 1),
            media_type: ATOM_TYPE,
        });
        links.push(FeedLink {
            rel: "first",
            href: route.to_string(),
            media_type: ATOM_TYPE,
        });
    }
    if page_number < last_page {
        links.push(FeedLink {
            rel: "next",
            href: page_href(route, page_number + 1),
            media_type: ATOM_TYPE,
        });
        links.push(FeedLink {
            rel: "last",
            href: page_href(route, last_page),
            media_type: ATOM_TYPE,
        });
    }

    let entries = page
        .items
        .iter()
        .map(|book| FeedEntry {
            id: book_identity(library_uuid, book.uuid.as_deref(), book.id),
            title: book.title.clone(),
            updated: timestamp(book.updated_at),
            authors: book
                .authors
                .iter()
                .map(|author| author.name.clone())
                .collect(),
            published: timestamp(book.created_at),
            languages: book.language_codes.clone(),
            identifiers: book
                .identifiers
                .iter()
                .map(|identifier| identifier.value.clone())
                .collect(),
            categories: book.tags.clone(),
            acquisition_links: book
                .files
                .iter()
                .map(|file| {
                    (
                        ACQUISITION_REL.to_string(),
                        format!(
                            "/opds/books/{}/files/{}/{}",
                            book.id.as_i32(),
                            urlencoding::encode(&file.format),
                            urlencoding::encode(&format!(
                                "{}.{}",
                                file.name,
                                file.format.to_ascii_lowercase()
                            ))
                        ),
                        assets::mime_type(&file.format).to_string(),
                    )
                })
                .collect(),
            image_link: book
                .has_cover
                .then(|| format!("/opds/books/{}/cover", book.id.as_i32())),
            content: Some(book.description.clone().unwrap_or_default()),
        })
        .collect();

    let feed = Feed {
        id: library_identity(library_uuid),
        title: format!("Citadel — {title}"),
        updated: feed_updated(updated_at),
        links,
        entries,
    };
    crate::xml::write_feed(&feed)
}

fn root_navigation_feed(library_uuid: &str) -> Result<Vec<u8>, quick_xml::Error> {
    let entries = [
        ("all", "All Books", "/opds/all", ATOM_TYPE),
        ("recent", "Recently Modified", "/opds/recent", ATOM_TYPE),
        ("unread", "Unread", "/opds/unread", ATOM_TYPE),
        ("authors", "Authors", "/opds/authors", NAVIGATION_TYPE),
        ("series", "Series", "/opds/series", NAVIGATION_TYPE),
        ("tags", "Tags", "/opds/tags", NAVIGATION_TYPE),
        ("genres", "Genres", "/opds/genres", NAVIGATION_TYPE),
    ];
    let feed = Feed {
        id: navigation_identity(library_uuid, "/opds"),
        title: "Citadel — Citadel".to_string(),
        updated: feed_updated(None),
        links: vec![
            FeedLink {
                rel: "self",
                href: "/opds".to_string(),
                media_type: NAVIGATION_TYPE,
            },
            FeedLink {
                rel: "start",
                href: "/opds".to_string(),
                media_type: NAVIGATION_TYPE,
            },
            FeedLink {
                rel: "search",
                href: "/opds/opensearch.xml".to_string(),
                media_type: OPENSEARCH_TYPE,
            },
        ],
        entries: entries
            .into_iter()
            .map(|(id, title, href, media_type)| navigation_entry(library_uuid, id, title, href, media_type, None))
            .collect::<Result<Vec<_>, _>>()?,
    };
    crate::xml::write_feed(&feed)
}

fn facet_navigation_feed(
    library_uuid: &str,
    kind: CatalogFacetKind,
    facets: &[CatalogFacet],
) -> Result<Vec<u8>, quick_xml::Error> {
    let feed = Feed {
        id: navigation_identity(library_uuid, kind.route()),
        title: format!("Citadel — {}", kind.title()),
        updated: feed_updated(None),
        links: vec![
            FeedLink {
                rel: "self",
                href: kind.route().to_string(),
                media_type: NAVIGATION_TYPE,
            },
            FeedLink {
                rel: "start",
                href: "/opds".to_string(),
                media_type: NAVIGATION_TYPE,
            },
            FeedLink {
                rel: "up",
                href: "/opds".to_string(),
                media_type: NAVIGATION_TYPE,
            },
        ],
        entries: facets
            .iter()
            .map(|facet| {
                navigation_entry(
                    library_uuid,
                    &facet.id.to_string(),
                    &facet.title,
                    &format!("{}/{}", kind.route(), facet.id),
                    ATOM_TYPE,
                    facet.book_count,
                )
            })
            .collect::<Result<Vec<_>, _>>()?,
    };
    crate::xml::write_feed(&feed)
}

fn navigation_entry(
    library_uuid: &str,
    id: &str,
    title: &str,
    href: &str,
    media_type: &str,
    count: Option<i64>,
) -> Result<FeedEntry, quick_xml::Error> {
    Ok(FeedEntry {
        id: navigation_identity(library_uuid, id),
        title: title.to_string(),
        updated: feed_updated(None),
        authors: Vec::new(),
        published: feed_updated(None),
        languages: Vec::new(),
        identifiers: Vec::new(),
        categories: Vec::new(),
        acquisition_links: vec![(
            "subsection".to_string(),
            href.to_string(),
            media_type.to_string(),
        )],
        image_link: None,
        content: count.map(|count| format!("{count} books")),
    })
}

fn opensearch_xml() -> Vec<u8> {
    br#"<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>Citadel</ShortName>
  <Description>Search the active Citadel library</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <OutputEncoding>UTF-8</OutputEncoding>
  <Url type="application/atom+xml;profile=opds-catalog;kind=acquisition" template="/opds/search?q={searchTerms}"/>
</OpenSearchDescription>"#
        .to_vec()
}

fn page_count(total: u64) -> u64 {
    total.div_ceil(PAGE_SIZE)
}

fn page_href(route: &str, page: u64) -> String {
    if page == 1 {
        route.to_string()
    } else if route.contains('?') {
        format!("{route}&page={page}")
    } else {
        format!("{route}?page={page}")
    }
}

fn feed_updated(updated_at: Option<NaiveDateTime>) -> String {
    updated_at
        .map(timestamp)
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

fn timestamp(timestamp: NaiveDateTime) -> String {
    timestamp
        .and_utc()
        .to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

fn calibre_error(error: CalibreError) -> Response {
    match error {
        CalibreError::LibraryNotInitialized => {
            public_error(StatusCode::SERVICE_UNAVAILABLE, "No active library")
        }
        CalibreError::BookNotFound(_)
        | CalibreError::BookFileNotFound(_, _)
        | CalibreError::BookCoverNotFound(_)
        | CalibreError::AssetFileMissing(_) => {
            public_error(StatusCode::NOT_FOUND, "Asset not found")
        }
        CalibreError::InvalidBookFormat(_) => {
            public_error(StatusCode::BAD_REQUEST, "Invalid asset request")
        }
        CalibreError::Database(message)
            if message.to_ascii_lowercase().contains("busy")
                || message.to_ascii_lowercase().contains("locked") =>
        {
            public_error(StatusCode::SERVICE_UNAVAILABLE, "Library busy")
        }
        _ => public_error(StatusCode::INTERNAL_SERVER_ERROR, "Catalog unavailable"),
    }
}

fn public_error(status: StatusCode, message: &'static str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        message,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{book_identity, library_identity};
    use crate::xml::valid_xml_char;
    use chrono::{DateTime, NaiveDate};
    use diesel::{Connection, RunQueryDsl};
    use libcalibre::{
        library::Book, util::get_db_path, BookAdd, BookFileInfo, BookIdentifier, BookUpdate,
        Library, LibraryAuthor,
    };
    use quick_xml::{events::Event, name::ResolveResult, NsReader};
    use std::{collections::HashMap, path::PathBuf, sync::Mutex};
    use tempfile::TempDir;

    fn book(title: &str, uuid: &str, id: i32) -> Book {
        Book {
            id: BookId(id),
            uuid: Some(uuid.to_string()),
            title: title.to_string(),
            sortable_title: None,
            authors: vec![LibraryAuthor {
                id: libcalibre::AuthorId(1),
                name: "A <Writer> & Co".to_string(),
                sort: "Writer, A".to_string(),
                link: None,
            }],
            tags: Vec::new(),
            series: None,
            series_index: None,
            description: Some("Words <with> & symbols".to_string()),
            language_codes: vec!["eng".to_string()],
            identifiers: Vec::new(),
            has_cover: true,
            is_read: false,
            files: vec![BookFileInfo {
                id: 1,
                format: "EPUB".to_string(),
                name: "book".to_string(),
                uncompressed_size: 3,
            }],
            created_at: NaiveDate::from_ymd_opt(2024, 1, 2)
                .unwrap()
                .and_hms_opt(3, 4, 5)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2024, 2, 3)
                .unwrap()
                .and_hms_opt(4, 5, 6)
                .unwrap(),
            book_dir_path: "Author/Book".to_string(),
        }
    }

    struct MemorySource {
        books: Vec<Book>,
    }

    impl CatalogSource for MemorySource {
        fn active_library_id(&self) -> Result<String, CalibreError> {
            Ok("550e8400-e29b-41d4-a716-446655440000".to_string())
        }

        fn book_page(
            &self,
            query: CatalogBookQuery,
        ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError> {
            let items = self
                .books
                .iter()
                .skip(query.offset as usize)
                .take(query.limit as usize)
                .cloned()
                .collect();
            Ok((
                "550e8400-e29b-41d4-a716-446655440000".to_string(),
                self.books.iter().map(|book| book.updated_at).max(),
                BookPage {
                    items,
                    total: self.books.len() as u64,
                },
            ))
        }

        fn book_file(
            &self,
            book_id: BookId,
            format: &str,
        ) -> Result<ResolvedBookAsset, CalibreError> {
            Err(CalibreError::BookFileNotFound(book_id, format.to_string()))
        }

        fn book_cover(&self, book_id: BookId) -> Result<ResolvedBookAsset, CalibreError> {
            Err(CalibreError::BookCoverNotFound(book_id))
        }
    }

    struct LibrarySource {
        library: Mutex<Library>,
    }

    struct NoLibrary;

    struct FailureSource(fn() -> CalibreError);

    impl CatalogSource for NoLibrary {
        fn active_library_id(&self) -> Result<String, CalibreError> {
            Err(CalibreError::LibraryNotInitialized)
        }

        fn book_page(
            &self,
            _query: CatalogBookQuery,
        ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError> {
            Err(CalibreError::LibraryNotInitialized)
        }

        fn book_file(
            &self,
            _book_id: BookId,
            _format: &str,
        ) -> Result<ResolvedBookAsset, CalibreError> {
            Err(CalibreError::LibraryNotInitialized)
        }

        fn book_cover(&self, _book_id: BookId) -> Result<ResolvedBookAsset, CalibreError> {
            Err(CalibreError::LibraryNotInitialized)
        }
    }

    impl CatalogSource for FailureSource {
        fn active_library_id(&self) -> Result<String, CalibreError> {
            Err((self.0)())
        }

        fn book_page(
            &self,
            _query: CatalogBookQuery,
        ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError> {
            Err((self.0)())
        }

        fn book_file(
            &self,
            _book_id: BookId,
            _format: &str,
        ) -> Result<ResolvedBookAsset, CalibreError> {
            Err((self.0)())
        }

        fn book_cover(&self, _book_id: BookId) -> Result<ResolvedBookAsset, CalibreError> {
            Err((self.0)())
        }
    }

    impl CatalogSource for LibrarySource {
        fn active_library_id(&self) -> Result<String, CalibreError> {
            self.library.lock().unwrap().library_uuid()
        }

        fn book_page(
            &self,
            query: CatalogBookQuery,
        ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError> {
            let mut library = self.library.lock().unwrap();
            let uuid = library.library_uuid()?;
            let updated = library.catalog_updated_at()?;
            let page = library.query_acquirable_books_with(query.into_calibre())?;
            Ok((uuid, updated, page))
        }

        fn authors(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
            self.library.lock().unwrap().list_authors().map(|items| {
                items
                    .into_iter()
                    .map(|item| CatalogFacet {
                        id: item.id.as_i32(),
                        title: item.name,
                        book_count: Some(item.book_count),
                    })
                    .collect()
            })
        }

        fn series(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
            self.library.lock().unwrap().list_series().map(|items| {
                items
                    .into_iter()
                    .map(|item| CatalogFacet {
                        id: item.id,
                        title: item.name,
                        book_count: Some(item.book_count),
                    })
                    .collect()
            })
        }

        fn tags(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
            self.library.lock().unwrap().list_tags().map(|items| {
                items
                    .into_iter()
                    .map(|item| CatalogFacet {
                        id: item.id,
                        title: item.name,
                        book_count: Some(item.book_count),
                    })
                    .collect()
            })
        }

        fn genres(&self) -> Result<Vec<CatalogFacet>, CalibreError> {
            self.library.lock().unwrap().list_genres().map(|items| {
                items
                    .into_iter()
                    .map(|item| CatalogFacet {
                        id: item.id,
                        title: item.name,
                        book_count: Some(item.book_count),
                    })
                    .collect()
            })
        }

        fn book_file(
            &self,
            book_id: BookId,
            format: &str,
        ) -> Result<ResolvedBookAsset, CalibreError> {
            self.library
                .lock()
                .unwrap()
                .resolve_book_file(book_id, format)
        }

        fn book_cover(&self, book_id: BookId) -> Result<ResolvedBookAsset, CalibreError> {
            self.library.lock().unwrap().resolve_book_cover(book_id)
        }
    }

    fn test_library() -> (TempDir, Library) {
        let directory = tempfile::tempdir().unwrap();
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../crates/libcalibre/tests/fixtures/empty_library/metadata.db");
        std::fs::copy(fixture, directory.path().join("metadata.db")).unwrap();
        let db_path = get_db_path(directory.path().to_str().unwrap()).unwrap();
        (directory, Library::new(db_path).unwrap())
    }

    async fn loopback(source: Arc<dyn CatalogSource>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router(source, OpdsBasicAuth::disabled()))
                .await
                .unwrap();
        });
        (format!("http://{address}"), task)
    }

    #[derive(Default)]
    struct ParsedFeed {
        feed_id: Option<String>,
        feed_title: Option<String>,
        feed_updated: Option<String>,
        ids: Vec<String>,
        titles: Vec<String>,
        content: Vec<String>,
        acquisition_hrefs: Vec<String>,
        image_hrefs: Vec<String>,
        subsection_hrefs: Vec<String>,
        next: Option<String>,
        previous: Option<String>,
    }

    fn parsed_feed(xml: &[u8]) -> ParsedFeed {
        const ATOM: &[u8] = b"http://www.w3.org/2005/Atom";
        let mut reader = NsReader::from_reader(xml);
        reader.config_mut().trim_text(false);
        let mut parsed = ParsedFeed::default();
        let mut current = None::<(Vec<u8>, String)>;
        let mut in_entry = false;
        loop {
            match reader.read_resolved_event() {
                Ok((ResolveResult::Bound(namespace), Event::Start(element)))
                    if namespace.as_ref() == ATOM =>
                {
                    let name = element.local_name().as_ref().to_vec();
                    if name == b"entry" {
                        in_entry = true;
                    } else if in_entry && matches!(name.as_slice(), b"id" | b"title" | b"content") {
                        current = Some((name, String::new()));
                    } else if !in_entry && matches!(name.as_slice(), b"id" | b"title" | b"updated")
                    {
                        current = Some((name, String::new()));
                    }
                }
                Ok((ResolveResult::Bound(namespace), Event::Empty(element)))
                    if namespace.as_ref() == ATOM && element.local_name().as_ref() == b"link" =>
                {
                    let rel = element
                        .attributes()
                        .flatten()
                        .find(|attribute| attribute.key.as_ref() == b"rel")
                        .and_then(|attribute| attribute.unescape_value().ok())
                        .map(|value| value.into_owned());
                    let href = element
                        .attributes()
                        .flatten()
                        .find(|attribute| attribute.key.as_ref() == b"href")
                        .and_then(|attribute| attribute.unescape_value().ok())
                        .map(|value| value.into_owned());
                    match (rel.as_deref(), href) {
                        (Some(ACQUISITION_REL), Some(href)) if in_entry => {
                            parsed.acquisition_hrefs.push(href)
                        }
                        (Some(IMAGE_REL), Some(href)) if in_entry => parsed.image_hrefs.push(href),
                        (Some("subsection"), Some(href)) if in_entry => {
                            parsed.subsection_hrefs.push(href)
                        }
                        (Some("next"), Some(href)) => parsed.next = Some(href),
                        (Some("previous"), Some(href)) => parsed.previous = Some(href),
                        _ => {}
                    }
                }
                Ok((_, Event::Text(text))) if current.is_some() => {
                    current
                        .as_mut()
                        .unwrap()
                        .1
                        .push_str(&text.decode().unwrap());
                }
                Ok((_, Event::GeneralRef(reference))) if current.is_some() => {
                    let decoded = reference.decode().unwrap();
                    let value = match decoded.as_ref() {
                        "amp" => "&",
                        "lt" => "<",
                        "gt" => ">",
                        "quot" => "\"",
                        "apos" => "'",
                        _ => "",
                    };
                    current.as_mut().unwrap().1.push_str(value);
                }
                Ok((ResolveResult::Bound(namespace), Event::End(element)))
                    if namespace.as_ref() == ATOM =>
                {
                    if element.local_name().as_ref() == b"entry" {
                        in_entry = false;
                    }
                    if let Some((name, value)) = current.take() {
                        if element.local_name().as_ref() == name.as_slice() {
                            match name.as_slice() {
                                b"id" => {
                                    if in_entry {
                                        parsed.ids.push(value);
                                    } else {
                                        parsed.feed_id = Some(value);
                                    }
                                }
                                b"title" => {
                                    if in_entry {
                                        parsed.titles.push(value);
                                    } else {
                                        parsed.feed_title = Some(value);
                                    }
                                }
                                b"content" => parsed.content.push(value),
                                b"updated" => parsed.feed_updated = Some(value),
                                _ => {}
                            }
                        } else {
                            current = Some((name, value));
                        }
                    }
                }
                Ok((_, Event::Eof)) => break,
                Err(error) => panic!("invalid OPDS XML: {error}"),
                _ => {}
            }
        }
        parsed
    }

    #[test]
    fn writer_escapes_metadata_and_emits_acquisition_contract() {
        let mut legacy_book = book("A \u{1}<Book> & More", "not-a-uuid", 42);
        legacy_book.authors[0].name = "A \u{0}<Writer> & Co".to_string();
        legacy_book.description = Some("Words \u{b}<with> & symbols".to_string());
        legacy_book.tags = vec!["Tag \u{c}<one> & two".to_string()];
        legacy_book.identifiers = vec![BookIdentifier {
            id: 1,
            label: "custom".to_string(),
            value: "ID \u{7}<one> & two".to_string(),
        }];
        let page = BookPage {
            items: vec![legacy_book],
            total: 1,
        };
        let xml = String::from_utf8(
            acquisition_feed("bad-library", None, &page, 1, 1, "/opds", "All Books").unwrap(),
        )
        .unwrap();
        assert!(xml.contains("A &lt;Book&gt; &amp; More"));
        assert!(xml.contains("A &lt;Writer&gt; &amp; Co"));
        assert!(xml.contains("Words &lt;with&gt; &amp; symbols"));
        assert!(xml.contains("term=\"Tag &lt;one&gt; &amp; two\""));
        assert!(xml.contains("ID &lt;one&gt; &amp; two"));
        assert!(!xml.chars().any(|character| !valid_xml_char(character)));
        assert!(xml.contains("urn:citadel:book:6261642d6c696272617279:42"));
        assert!(xml.contains("rel=\"http://opds-spec.org/acquisition\""));
        assert!(xml.contains("type=\"application/epub+zip\""));
        assert!(xml.contains("href=\"/opds/books/42/files/EPUB/book.epub\""));
        assert!(xml.contains("rel=\"http://opds-spec.org/image\""));
        let parsed = parsed_feed(xml.as_bytes());
        assert_eq!(parsed.titles, ["A <Book> & More"]);
        assert_eq!(parsed.content, ["Words <with> & symbols"]);
        assert_eq!(parsed.acquisition_hrefs.len(), 1);
    }

    #[test]
    fn pagination_links_are_bounded() {
        let page = BookPage {
            items: Vec::new(),
            total: 101,
        };
        let first = String::from_utf8(
            acquisition_feed("id", None, &page, 1, 3, "/opds/all", "All Books").unwrap(),
        )
        .unwrap();
        assert!(first.contains("rel=\"next\" href=\"/opds/all?page=2\""));
        assert!(!first.contains("rel=\"previous\""));
        let last = String::from_utf8(
            acquisition_feed("id", None, &page, 3, 3, "/opds/all", "All Books").unwrap(),
        )
        .unwrap();
        assert!(last.contains("rel=\"previous\" href=\"/opds/all?page=2\""));
        assert!(!last.contains("rel=\"next\""));
    }

    #[test]
    fn catalog_queries_translate_to_bounded_library_queries() {
        let query = CatalogBookQuery {
            filter: CatalogFilter::Unread,
            sort: CatalogSort::Updated,
            limit: 50,
            offset: 100,
        }
        .into_calibre();
        assert!(query.hide_read);
        assert_eq!(query.sort, BookSortOrder::UpdatedDesc);
        assert_eq!(query.limit, Some(50));
        assert_eq!(query.offset, 100);

        let genre = CatalogBookQuery {
            filter: CatalogFilter::Genre(1),
            sort: CatalogSort::Title,
            limit: 50,
            offset: 0,
        }
        .into_calibre();
        assert_eq!(genre.genre_id, Some(1));
    }

    #[tokio::test]
    async fn root_exposes_v1_navigation_and_opensearch() {
        let (base, server) = loopback(Arc::new(MemorySource { books: Vec::new() })).await;
        let response = reqwest::get(format!("{base}/opds")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            NAVIGATION_CONTENT_TYPE
        );
        let bytes = response.bytes().await.unwrap();
        let feed = parsed_feed(&bytes);
        assert_eq!(
            feed.titles,
            [
                "All Books",
                "Recently Modified",
                "Unread",
                "Authors",
                "Series",
                "Tags",
                "Genres",
            ]
        );
        assert_eq!(
            feed.subsection_hrefs,
            [
                "/opds/all",
                "/opds/recent",
                "/opds/unread",
                "/opds/authors",
                "/opds/series",
                "/opds/tags",
                "/opds/genres",
            ]
        );
        let xml = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(xml.contains("rel=\"search\""));
        assert!(xml.contains("/opds/opensearch.xml"));

        let search = reqwest::get(format!("{base}/opds/opensearch.xml"))
            .await
            .unwrap();
        assert_eq!(search.status(), StatusCode::OK);
        assert_eq!(search.headers()[header::CONTENT_TYPE], OPENSEARCH_TYPE);
        let search = search.text().await.unwrap();
        assert!(search.contains("{searchTerms}"));
        assert!(search.contains("/opds/search?q="));
        server.abort();
    }

    #[tokio::test]
    async fn search_is_limited_and_preserves_query_in_pagination_links() {
        let books = (0..51)
            .map(|id| book(&format!("Result {id}"), &format!("uuid-{id}"), id + 1))
            .collect();
        let (base, server) = loopback(Arc::new(MemorySource { books })).await;
        let response = reqwest::get(format!("{base}/opds/search?q=space%20%25%20_"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let feed = parsed_feed(&response.bytes().await.unwrap());
        assert_eq!(
            feed.next.as_deref(),
            Some("/opds/search?q=space%20%25%20_&page=2")
        );

        for query in [String::new(), "x".repeat(MAX_SEARCH_LENGTH + 1)] {
            let response = reqwest::get(format!(
                "{base}/opds/search?q={}",
                urlencoding::encode(&query)
            ))
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        server.abort();
    }

    #[test]
    fn valid_uuids_are_normalized_and_fallbacks_are_deterministic() {
        assert_eq!(
            library_identity("550E8400-E29B-41D4-A716-446655440000"),
            "urn:uuid:550e8400-e29b-41d4-a716-446655440000"
        );
        assert_eq!(
            book_identity("lib", Some("bad"), BookId(7)),
            book_identity("lib", Some("bad"), BookId(7))
        );
    }

    #[tokio::test]
    async fn loopback_pagination_visits_every_entry_once() {
        let books = (1..=101)
            .map(|id| {
                book(
                    &format!("Book {id:03}"),
                    &uuid::Uuid::new_v4().to_string(),
                    id,
                )
            })
            .collect();
        let (base, server) = loopback(Arc::new(MemorySource { books })).await;
        let client = reqwest::Client::new();
        let mut path = "/opds/all".to_string();
        let mut ids = Vec::new();
        let mut page_number = 1;
        loop {
            let response = client.get(format!("{base}{path}")).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], ATOM_CONTENT_TYPE);
            assert!(response.headers().get(header::LAST_MODIFIED).is_none());
            let feed = parsed_feed(&response.bytes().await.unwrap());
            if page_number == 1 {
                assert!(feed.previous.is_none());
            } else {
                assert!(feed.previous.is_some());
            }
            ids.extend(feed.ids);
            match feed.next {
                Some(next) => path = next,
                None => break,
            }
            page_number += 1;
        }
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 101);
        assert_eq!(page_number, 3);
        server.abort();
    }

    #[tokio::test]
    async fn loopback_serves_real_library_feed_head_get_and_range() {
        let (directory, mut library) = test_library();
        let source_path = directory.path().join("L'été & 漢字.epub");
        std::fs::write(&source_path, b"0123456789").unwrap();
        let added = library
            .add_book(BookAdd {
                title: "Café <Book> & More".to_string(),
                author_names: vec!["A & Author".to_string()],
                tags: Some(vec!["One & Two".to_string()]),
                series: None,
                series_index: None,
                publisher: None,
                publication_date: None,
                rating: None,
                comments: Some("Description <escaped> & intact".to_string()),
                identifiers: HashMap::new(),
                language: Some("eng".to_string()),
                file_paths: vec![source_path],
            })
            .unwrap();
        library
            .upsert_book_identifier(
                added.id,
                "custom".to_string(),
                "ID <one> & 漢字".to_string(),
                None,
            )
            .unwrap();
        let after_identifier = library.get_book(added.id).unwrap().updated_at;
        assert!(after_identifier > added.updated_at);
        library
            .update_book(
                added.id,
                BookUpdate {
                    title: None,
                    author_names: None,
                    author_ids: None,
                    description: Some("Description <escaped> & intact".to_string()),
                    is_read: None,
                    tags: None,
                    series: None,
                    series_index: None,
                    language_codes: None,
                    publisher: None,
                    publication_date: None,
                    rating: None,
                    comments: None,
                    identifiers: None,
                },
            )
            .unwrap();
        let after_metadata = library.get_book(added.id).unwrap().updated_at;
        assert!(after_metadata > after_identifier);
        library
            .set_book_cover(added.id, b"cover-bytes".to_vec())
            .unwrap();
        assert!(library.get_book(added.id).unwrap().updated_at > after_metadata);
        let metadata_only = library
            .add_book(BookAdd {
                title: "Metadata only".to_string(),
                author_names: vec!["Nobody".to_string()],
                tags: None,
                series: None,
                series_index: None,
                publisher: None,
                publication_date: None,
                rating: None,
                comments: None,
                identifiers: HashMap::new(),
                language: None,
                file_paths: Vec::new(),
            })
            .unwrap();

        let database_path = library.database_path().to_string();
        drop(library);
        let mut connection = diesel::SqliteConnection::establish(&database_path).unwrap();
        libcalibre::persistence::register_sql_functions(&mut connection).unwrap();
        diesel::sql_query(format!(
            "UPDATE books SET uuid = NULL WHERE id = {}",
            added.id.as_i32()
        ))
        .execute(&mut connection)
        .unwrap();
        diesel::sql_query("UPDATE books SET last_modified = '2000-01-01 00:00:00'")
            .execute(&mut connection)
            .unwrap();
        diesel::sql_query(format!(
            "INSERT INTO data (book, format, uncompressed_size, name) \
             VALUES ({}, 'PDF', 10, 'missing')",
            metadata_only.id.as_i32()
        ))
        .execute(&mut connection)
        .unwrap();
        drop(connection);
        let mut library =
            Library::new(get_db_path(directory.path().to_str().unwrap()).unwrap()).unwrap();
        assert_eq!(library.get_book(added.id).unwrap().uuid, None);
        assert!(
            library.catalog_updated_at().unwrap().unwrap()
                > library.get_book(added.id).unwrap().updated_at
        );

        let (base, server) = loopback(Arc::new(LibrarySource {
            library: Mutex::new(library),
        }))
        .await;
        let client = reqwest::Client::new();
        let feed_head = client
            .head(format!("{base}/opds/all"))
            .send()
            .await
            .unwrap();
        assert_eq!(feed_head.status(), StatusCode::OK);
        assert_eq!(feed_head.headers()[header::CONTENT_TYPE], ATOM_CONTENT_TYPE);
        assert!(feed_head.headers().get(header::LAST_MODIFIED).is_none());
        assert!(feed_head.bytes().await.unwrap().is_empty());
        let response = client.get(format!("{base}/opds/all")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.bytes().await.unwrap();
        let xml = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(xml.contains("A &amp; Author"));
        assert!(xml.contains("term=\"One &amp; Two\""));
        assert!(xml.contains("ID &lt;one&gt; &amp; 漢字"));
        let feed = parsed_feed(&bytes);
        assert_eq!(feed.titles, ["Café <Book> & More"]);
        assert_eq!(feed.content, ["Description <escaped> & intact"]);
        assert!(feed.ids[0].starts_with("urn:citadel:book:"));
        assert_eq!(feed.acquisition_hrefs.len(), 1);
        let href = &feed.acquisition_hrefs[0];
        assert!(href.ends_with(".epub"));
        assert!(href.contains("%"));

        assert_eq!(feed.image_hrefs.len(), 1);
        let cover = client
            .get(format!("{base}{}", feed.image_hrefs[0]))
            .send()
            .await
            .unwrap();
        assert_eq!(cover.status(), StatusCode::OK);
        assert_eq!(cover.headers()[header::CONTENT_TYPE], "image/jpeg");
        assert_eq!(cover.bytes().await.unwrap(), b"cover-bytes".as_slice());

        let head = client.head(format!("{base}{href}")).send().await.unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()[header::CONTENT_TYPE], "application/epub+zip");
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "10");
        assert!(head.bytes().await.unwrap().is_empty());

        let get = client.get(format!("{base}{href}")).send().await.unwrap();
        assert_eq!(get.bytes().await.unwrap(), b"0123456789".as_slice());
        let range = client
            .get(format!("{base}{href}"))
            .header(header::RANGE, "bytes=2-5")
            .send()
            .await
            .unwrap();
        assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(range.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(range.bytes().await.unwrap(), b"2345".as_slice());

        let missing = client
            .get(format!(
                "{base}/opds/books/{}/files/PDF/missing.pdf",
                added.id.as_i32()
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_eq!(missing.text().await.unwrap(), "Asset not found");
        server.abort();
    }

    #[tokio::test]
    async fn real_library_paging_has_no_holes_around_fileless_books() {
        let (directory, mut library) = test_library();
        let source_path = directory.path().join("shared.epub");
        std::fs::write(&source_path, b"book").unwrap();
        for index in 0..55 {
            let has_file = !matches!(index, 4 | 17 | 33 | 49);
            library
                .add_book(BookAdd {
                    title: format!("Book {index:02}"),
                    author_names: vec!["Author".to_string()],
                    tags: None,
                    series: None,
                    series_index: None,
                    publisher: None,
                    publication_date: None,
                    rating: None,
                    comments: None,
                    identifiers: HashMap::new(),
                    language: None,
                    file_paths: has_file.then(|| source_path.clone()).into_iter().collect(),
                })
                .unwrap();
        }

        let (base, server) = loopback(Arc::new(LibrarySource {
            library: Mutex::new(library),
        }))
        .await;
        let client = reqwest::Client::new();
        let first = client.get(format!("{base}/opds/all")).send().await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let first = parsed_feed(&first.bytes().await.unwrap());
        assert_eq!(first.ids.len(), 50);
        let second_path = first
            .next
            .expect("51 resolvable books require a second page");
        let second = client
            .get(format!("{base}{second_path}"))
            .send()
            .await
            .unwrap();
        let second = parsed_feed(&second.bytes().await.unwrap());
        assert_eq!(second.ids.len(), 1);
        assert!(second.next.is_none());
        assert!(second.previous.is_some());
        let mut ids = first.ids;
        ids.extend(second.ids);
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 51);
        server.abort();
    }

    #[tokio::test]
    async fn real_library_genre_navigation_is_distinct_from_tags() {
        let (directory, mut library) = test_library();
        let source_path = directory.path().join("shared.epub");
        std::fs::write(&source_path, b"book").unwrap();
        let fantasy = library
            .add_book(BookAdd {
                title: "Genre Match".to_string(),
                author_names: vec!["Author".to_string()],
                tags: Some(vec!["Unrelated Tag".to_string()]),
                series: None,
                series_index: None,
                publisher: None,
                publication_date: None,
                rating: None,
                comments: None,
                identifiers: HashMap::new(),
                language: None,
                file_paths: vec![source_path.clone()],
            })
            .unwrap();
        library
            .add_book(BookAdd {
                title: "Other Book".to_string(),
                author_names: vec!["Author".to_string()],
                tags: Some(vec!["Fantasy".to_string()]),
                series: None,
                series_index: None,
                publisher: None,
                publication_date: None,
                rating: None,
                comments: None,
                identifiers: HashMap::new(),
                language: None,
                file_paths: vec![source_path],
            })
            .unwrap();
        library
            .set_book_genres(fantasy.id, vec!["Fantasy".to_string()])
            .unwrap();

        let (base, server) = loopback(Arc::new(LibrarySource {
            library: Mutex::new(library),
        }))
        .await;
        let navigation = reqwest::get(format!("{base}/opds/genres")).await.unwrap();
        assert_eq!(navigation.status(), StatusCode::OK);
        let navigation = parsed_feed(&navigation.bytes().await.unwrap());
        assert_eq!(navigation.titles, ["Fantasy"]);
        assert_eq!(navigation.subsection_hrefs.len(), 1);

        let books = reqwest::get(format!("{base}{}", navigation.subsection_hrefs[0]))
            .await
            .unwrap();
        assert_eq!(books.status(), StatusCode::OK);
        let books = parsed_feed(&books.bytes().await.unwrap());
        assert_eq!(books.titles, ["Genre Match"]);
        server.abort();
    }

    #[tokio::test]
    async fn empty_and_unavailable_catalogs_return_valid_non_sensitive_responses() {
        let (base, server) = loopback(Arc::new(MemorySource { books: Vec::new() })).await;
        let response = reqwest::get(format!("{base}/opds/all")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], ATOM_CONTENT_TYPE);
        let feed = parsed_feed(&response.bytes().await.unwrap());
        assert!(feed.ids.is_empty());
        assert!(feed.titles.is_empty());
        let feed_id = feed.feed_id.expect("feed-level id present");
        assert!(!feed_id.is_empty());
        let feed_title = feed.feed_title.expect("feed-level title present");
        assert!(!feed_title.is_empty());
        let feed_updated = feed.feed_updated.expect("feed-level updated present");
        DateTime::parse_from_rfc3339(&feed_updated).expect("feed updated is valid RFC 3339");
        assert!(feed.next.is_none());
        assert!(feed.previous.is_none());
        server.abort();

        let (base, server) = loopback(Arc::new(NoLibrary)).await;
        let response = reqwest::get(format!("{base}/opds")).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.text().await.unwrap(), "No active library");
        server.abort();
    }

    #[tokio::test]
    async fn invalid_pages_and_library_failures_are_bounded_and_redacted() {
        let client = reqwest::Client::new();
        let (base, server) = loopback(Arc::new(MemorySource { books: Vec::new() })).await;
        for page in ["0", "18446744073709551615"] {
            let response = client
                .get(format!("{base}/opds/all?page={page}"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        let response = client
            .get(format!("{base}/opds/all?page=2"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let response = client
            .get(format!("{base}/opds/all?page=nope"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        server.abort();

        let (base, server) = loopback(Arc::new(FailureSource(|| {
            CalibreError::Database("database is locked at /private/library/metadata.db".to_string())
        })))
        .await;
        let response = client.get(format!("{base}/opds")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.text().await.unwrap(), "Library busy");
        server.abort();

        let (base, server) = loopback(Arc::new(FailureSource(|| {
            CalibreError::DatabaseIntegrity("broken /private/library/metadata.db".to_string())
        })))
        .await;
        let response = client.get(format!("{base}/opds")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(response.text().await.unwrap(), "Catalog unavailable");
        server.abort();
    }
}
