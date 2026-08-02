use std::{borrow::Cow, io::Read, sync::Arc};

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
use libcalibre::{BookId, BookPage, CalibreError, ResolvedBookAsset};
use quick_xml::{
    events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event},
    Writer,
};
use serde::Deserialize;

use super::{
    assets::{self, AssetMethod},
    auth::{require_basic_auth, OpdsBasicAuth},
};

const PAGE_SIZE: i64 = 50;
const ACQUISITION_REL: &str = "http://opds-spec.org/acquisition";
const IMAGE_REL: &str = "http://opds-spec.org/image";
const ATOM_TYPE: &str = "application/atom+xml;profile=opds-catalog;kind=acquisition";
const ATOM_CONTENT_TYPE: &str =
    "application/atom+xml;profile=opds-catalog;kind=acquisition; charset=utf-8";

pub trait CatalogSource: Send + Sync + 'static {
    fn active_library_id(&self) -> Result<String, CalibreError>;

    fn book_page(
        &self,
        limit: i64,
        offset: i64,
    ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError>;
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

pub fn router(source: Arc<dyn CatalogSource>, auth: OpdsBasicAuth) -> Router {
    Router::new()
        .route("/opds", get(root_feed))
        .route("/opds/all", get(all_books_feed))
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
    feed(state, query, "/opds").await
}

async fn all_books_feed(state: State<CatalogState>, query: Query<PageQuery>) -> Response {
    feed(state, query, "/opds/all").await
}

async fn feed(
    State(state): State<CatalogState>,
    Query(query): Query<PageQuery>,
    route: &'static str,
) -> Response {
    let page_number = query.page.unwrap_or(1);
    if page_number == 0 {
        return public_error(StatusCode::BAD_REQUEST, "Invalid page");
    }
    let offset = match page_number
        .checked_sub(1)
        .and_then(|page| page.checked_mul(PAGE_SIZE as u64))
        .and_then(|offset| i64::try_from(offset).ok())
    {
        Some(offset) => offset,
        None => return public_error(StatusCode::BAD_REQUEST, "Invalid page"),
    };

    let source = state.source.clone();
    let result = tokio::task::spawn_blocking(move || source.book_page(PAGE_SIZE, offset)).await;
    let (library_uuid, updated_at, page) = match result {
        Ok(Ok(page)) => page,
        Ok(Err(error)) => return calibre_error(error),
        Err(_) => return public_error(StatusCode::INTERNAL_SERVER_ERROR, "Catalog unavailable"),
    };

    let last_page = page_count(page.total);
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
    let source = state.source.clone();
    let resolved = tokio::task::spawn_blocking(move || match format {
        Some(format) => source.book_file(book_id, &format),
        None => source.book_cover(book_id),
    })
    .await;
    let asset = match resolved {
        Ok(Ok(asset)) => asset,
        Ok(Err(error)) => return calibre_error(error),
        Err(_) => return public_error(StatusCode::INTERNAL_SERVER_ERROR, "Asset unavailable"),
    };

    let prepared =
        tokio::task::spawn_blocking(move || assets::prepare(&asset, method, range.as_deref()))
            .await;
    let prepared = match prepared {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
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
            return response;
        }
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
        Some(mut reader) => {
            let (sender, receiver) = tokio::sync::mpsc::channel(2);
            tokio::task::spawn_blocking(move || loop {
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
            });
            Body::from_stream(futures_util::stream::unfold(
                receiver,
                |mut receiver| async move { receiver.recv().await.map(|item| (item, receiver)) },
            ))
        }
        None => Body::empty(),
    };
    builder
        .body(body)
        .unwrap_or_else(|_| public_error(StatusCode::INTERNAL_SERVER_ERROR, "Asset unavailable"))
}

fn acquisition_feed(
    library_uuid: &str,
    updated_at: Option<NaiveDateTime>,
    page: &BookPage,
    page_number: u64,
    last_page: u64,
    route: &str,
) -> Result<Vec<u8>, quick_xml::Error> {
    let mut writer = Writer::new(Vec::new());
    writer.write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))?;
    let mut feed = BytesStart::new("feed");
    feed.push_attribute(("xmlns", "http://www.w3.org/2005/Atom"));
    feed.push_attribute(("xmlns:dc", "http://purl.org/dc/terms/"));
    writer.write_event(Event::Start(feed))?;
    text_element(&mut writer, "id", &library_identity(library_uuid))?;
    text_element(&mut writer, "title", "Citadel — All Books")?;
    text_element(&mut writer, "updated", &feed_updated(updated_at))?;
    writer.write_event(Event::Start(BytesStart::new("author")))?;
    text_element(&mut writer, "name", "Citadel")?;
    writer.write_event(Event::End(BytesEnd::new("author")))?;

    let self_href = page_href(route, page_number);
    link(&mut writer, "self", &self_href, ATOM_TYPE)?;
    link(&mut writer, "start", "/opds", ATOM_TYPE)?;
    if route != "/opds" {
        link(&mut writer, "up", "/opds", ATOM_TYPE)?;
    }
    if page_number > 1 {
        link(
            &mut writer,
            "previous",
            &page_href(route, page_number - 1),
            ATOM_TYPE,
        )?;
        link(&mut writer, "first", route, ATOM_TYPE)?;
    }
    if page_number < last_page {
        link(
            &mut writer,
            "next",
            &page_href(route, page_number + 1),
            ATOM_TYPE,
        )?;
        link(&mut writer, "last", &page_href(route, last_page), ATOM_TYPE)?;
    }

    for book in &page.items {
        writer.write_event(Event::Start(BytesStart::new("entry")))?;
        text_element(
            &mut writer,
            "id",
            &book_identity(library_uuid, book.uuid.as_deref(), book.id),
        )?;
        text_element(&mut writer, "title", &book.title)?;
        text_element(&mut writer, "updated", &timestamp(book.updated_at))?;
        for author in &book.authors {
            writer.write_event(Event::Start(BytesStart::new("author")))?;
            text_element(&mut writer, "name", &author.name)?;
            writer.write_event(Event::End(BytesEnd::new("author")))?;
        }
        text_element(&mut writer, "published", &timestamp(book.created_at))?;
        let mut content = BytesStart::new("content");
        content.push_attribute(("type", "text"));
        writer.write_event(Event::Start(content))?;
        writer.write_event(Event::Text(BytesText::new(&xml_text(
            book.description.as_deref().unwrap_or(""),
        ))))?;
        writer.write_event(Event::End(BytesEnd::new("content")))?;
        for language in &book.language_codes {
            text_element(&mut writer, "dc:language", language)?;
        }
        for identifier in &book.identifiers {
            text_element(&mut writer, "dc:identifier", &identifier.value)?;
        }
        for tag in &book.tags {
            let mut category = BytesStart::new("category");
            category.push_attribute(("term", xml_text(tag).as_ref()));
            writer.write_event(Event::Empty(category))?;
        }
        if book.has_cover {
            link(
                &mut writer,
                IMAGE_REL,
                &format!("/opds/books/{}/cover", book.id.as_i32()),
                "image/jpeg",
            )?;
        }
        for file in &book.files {
            link(
                &mut writer,
                ACQUISITION_REL,
                &format!(
                    "/opds/books/{}/files/{}/{}",
                    book.id.as_i32(),
                    urlencoding::encode(&file.format),
                    urlencoding::encode(&format!(
                        "{}.{}",
                        file.name,
                        file.format.to_ascii_lowercase()
                    ))
                ),
                assets::mime_type(&file.format),
            )?;
        }
        writer.write_event(Event::End(BytesEnd::new("entry")))?;
    }

    writer.write_event(Event::End(BytesEnd::new("feed")))?;
    Ok(writer.into_inner())
}

fn text_element(
    writer: &mut Writer<Vec<u8>>,
    name: &str,
    value: &str,
) -> Result<(), quick_xml::Error> {
    writer.write_event(Event::Start(BytesStart::new(name)))?;
    writer.write_event(Event::Text(BytesText::new(&xml_text(value))))?;
    writer.write_event(Event::End(BytesEnd::new(name)))?;
    Ok(())
}

fn link(
    writer: &mut Writer<Vec<u8>>,
    relation: &str,
    href: &str,
    media_type: &str,
) -> Result<(), quick_xml::Error> {
    let mut element = BytesStart::new("link");
    element.push_attribute(("rel", relation));
    element.push_attribute(("href", href));
    element.push_attribute(("type", media_type));
    writer.write_event(Event::Empty(element))?;
    Ok(())
}

fn page_count(total: i64) -> u64 {
    if total <= 0 {
        1
    } else {
        ((total as u64 - 1) / PAGE_SIZE as u64) + 1
    }
}

fn page_href(route: &str, page: u64) -> String {
    if page == 1 {
        route.to_string()
    } else {
        format!("{route}?page={page}")
    }
}

fn library_identity(raw_uuid: &str) -> String {
    match uuid::Uuid::parse_str(raw_uuid) {
        Ok(uuid) => format!("urn:uuid:{uuid}"),
        Err(_) => format!("urn:citadel:library:{}", hex(raw_uuid.as_bytes())),
    }
}

fn book_identity(library_uuid: &str, raw_uuid: Option<&str>, book_id: BookId) -> String {
    match raw_uuid.and_then(|value| uuid::Uuid::parse_str(value).ok()) {
        Some(uuid) => format!("urn:uuid:{uuid}"),
        None => format!(
            "urn:citadel:book:{}:{}",
            hex(library_uuid.as_bytes()),
            book_id.as_i32()
        ),
    }
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(char::from(HEX[usize::from(byte >> 4)]));
        result.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    result
}

fn xml_text(value: &str) -> Cow<'_, str> {
    if value.chars().all(valid_xml_char) {
        Cow::Borrowed(value)
    } else {
        Cow::Owned(
            value
                .chars()
                .filter(|character| valid_xml_char(*character))
                .collect(),
        )
    }
}

fn valid_xml_char(character: char) -> bool {
    matches!(character, '\u{9}' | '\u{a}' | '\u{d}')
        || ('\u{20}'..='\u{d7ff}').contains(&character)
        || ('\u{e000}'..='\u{fffd}').contains(&character)
        || ('\u{10000}'..='\u{10ffff}').contains(&character)
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
    use chrono::NaiveDate;
    use diesel::{Connection, RunQueryDsl};
    use libcalibre::{
        library::Book, util::get_db_path, BookAdd, BookFileInfo, BookIdentifier, BookUpdate,
        Library, LibraryAuthor,
    };
    use quick_xml::{name::ResolveResult, NsReader};
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
            self.books
                .first()
                .map(|_| "memory-library".to_string())
                .ok_or(CalibreError::LibraryNotInitialized)
        }

        fn book_page(
            &self,
            limit: i64,
            offset: i64,
        ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError> {
            let items = self
                .books
                .iter()
                .skip(offset as usize)
                .take(limit as usize)
                .cloned()
                .collect();
            Ok((
                "550e8400-e29b-41d4-a716-446655440000".to_string(),
                self.books.iter().map(|book| book.updated_at).max(),
                BookPage {
                    items,
                    total: self.books.len() as i64,
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
            _limit: i64,
            _offset: i64,
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
            _limit: i64,
            _offset: i64,
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
            limit: i64,
            offset: i64,
        ) -> Result<(String, Option<NaiveDateTime>, BookPage), CalibreError> {
            let mut library = self.library.lock().unwrap();
            let uuid = library.library_uuid()?;
            let updated = library.catalog_updated_at()?;
            let page = library.query_acquirable_books(limit, offset)?;
            Ok((uuid, updated, page))
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
            .join("../libcalibre/tests/fixtures/empty_library/metadata.db");
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
        ids: Vec<String>,
        titles: Vec<String>,
        content: Vec<String>,
        acquisition_hrefs: Vec<String>,
        image_hrefs: Vec<String>,
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
                                b"id" => parsed.ids.push(value),
                                b"title" => parsed.titles.push(value),
                                b"content" => parsed.content.push(value),
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
        let xml =
            String::from_utf8(acquisition_feed("bad-library", None, &page, 1, 1, "/opds").unwrap())
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
        let first =
            String::from_utf8(acquisition_feed("id", None, &page, 1, 3, "/opds/all").unwrap())
                .unwrap();
        assert!(first.contains("rel=\"next\" href=\"/opds/all?page=2\""));
        assert!(!first.contains("rel=\"previous\""));
        let last =
            String::from_utf8(acquisition_feed("id", None, &page, 3, 3, "/opds/all").unwrap())
                .unwrap();
        assert!(last.contains("rel=\"previous\" href=\"/opds/all?page=2\""));
        assert!(!last.contains("rel=\"next\""));
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
        let feed_head = client.head(format!("{base}/opds")).send().await.unwrap();
        assert_eq!(feed_head.status(), StatusCode::OK);
        assert_eq!(feed_head.headers()[header::CONTENT_TYPE], ATOM_CONTENT_TYPE);
        assert!(feed_head.headers().get(header::LAST_MODIFIED).is_none());
        assert!(feed_head.bytes().await.unwrap().is_empty());
        let response = client.get(format!("{base}/opds")).send().await.unwrap();
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
        let first = client.get(format!("{base}/opds")).send().await.unwrap();
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
    async fn empty_and_unavailable_catalogs_return_valid_non_sensitive_responses() {
        let (base, server) = loopback(Arc::new(MemorySource { books: Vec::new() })).await;
        let response = reqwest::get(format!("{base}/opds")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.bytes().await.unwrap();
        let feed = parsed_feed(&bytes);
        assert!(feed.ids.is_empty());
        assert!(String::from_utf8(bytes.to_vec())
            .unwrap()
            .contains("<author><name>Citadel</name></author>"));
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
                .get(format!("{base}/opds?page={page}"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        let response = client
            .get(format!("{base}/opds?page=2"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let response = client
            .get(format!("{base}/opds?page=nope"))
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
