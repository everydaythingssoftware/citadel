use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use citadel_core::store::CitadelStore;
use citadel_core::{contracts::LibraryBookQuery, library::LibraryService, HttpUrlBuilder};
use citadel_opds::{
    credential_store::OpdsCredentialSecret, CatalogSource, OpdsBindTarget, OpdsService,
    OpdsStartConfig,
};
use citadel_server::{api, CalibreCatalogSource};
use libcalibre::{BookAdd, Library};
use serde_json::{json, Value};
use tower::ServiceExt;

const PUBLIC_URL: &str = "https://books.example.com";

fn access(directory: &std::path::Path) -> (Arc<CitadelStore>, api::ApiAccess) {
    let accounts = Arc::new(CitadelStore::open(&directory.join("citadel.db")).unwrap());
    let calibre_id = CalibreCatalogSource::open(directory)
        .unwrap()
        .active_library_id()
        .unwrap();
    let library = accounts
        .register_library(&calibre_id, directory, None)
        .unwrap();
    if accounts.user("reader").is_err() {
        accounts.create_user("reader", "secret-password").unwrap();
        accounts.grant("reader", &library.id).unwrap();
    }
    let access = api::ApiAccess {
        accounts: accounts.clone(),
        library_id: library.id,
        public_url: api::PublicUrl::parse(PUBLIC_URL).unwrap(),
        secrets: Arc::new(
            citadel_core::vault::Vault::open_or_create(&directory.join("state/secrets")).unwrap(),
        ),
    };
    (accounts, access)
}

async fn sign_in(
    router: &Router,
    username: &str,
    password: &str,
) -> (StatusCode, Option<String>, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session")
                .header("content-type", "application/json")
                .header("origin", PUBLIC_URL)
                .body(Body::from(
                    json!({"username": username, "password": password}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let cookie = response.headers().get("set-cookie").map(|value| {
        value
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string()
    });
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, cookie, serde_json::from_slice(&body).unwrap())
}

async fn fixture() -> (tempfile::TempDir, OpdsService, Router, String, String) {
    fixture_with(api::UploadConfig::default()).await
}

async fn fixture_with(
    uploads: api::UploadConfig,
) -> (tempfile::TempDir, OpdsService, Router, String, String) {
    fixture_opened(CalibreCatalogSource::open, uploads).await
}

/// No provider is reachable unless a test stands one up locally.
fn metadata() -> Arc<api::Metadata> {
    metadata_at("http://127.0.0.1:9".into(), api::MetadataConfig::default())
}

fn metadata_at(base: String, config: api::MetadataConfig) -> Arc<api::Metadata> {
    let client = citadel_metadata::MetadataClient::with_endpoints(
        citadel_metadata::ClientOptions {
            version: "test".into(),
            contact: None,
            covers: citadel_metadata::CoverOptions {
                max_image_bytes: config.max_image_bytes,
                ..Default::default()
            },
        },
        citadel_metadata::Endpoints {
            openlibrary: base.clone(),
            hardcover: format!("{base}/graphql"),
            loc: format!("{base}/loc"),
            dnb: format!("{base}/dnb"),
            k10plus: format!("{base}/k10plus"),
            // The stand-in serves Hardcover's images from loopback.
            covers: citadel_metadata::CoverPolicy {
                hosts: vec![(
                    citadel_metadata::MetadataProvider::Hardcover,
                    citadel_metadata::HostRule::Exact("127.0.0.1".into()),
                )],
                https_only: false,
            },
        },
    )
    .unwrap();
    Arc::new(api::Metadata::with_client(config, client))
}

async fn fixture_opened(
    open: fn(&std::path::Path) -> Result<CalibreCatalogSource, String>,
    uploads: api::UploadConfig,
) -> (tempfile::TempDir, OpdsService, Router, String, String) {
    fixture_with_metadata(open, uploads, metadata()).await
}

async fn fixture_with_metadata(
    open: fn(&std::path::Path) -> Result<CalibreCatalogSource, String>,
    uploads: api::UploadConfig,
    metadata: Arc<api::Metadata>,
) -> (tempfile::TempDir, OpdsService, Router, String, String) {
    let directory = tempfile::tempdir().unwrap();
    std::fs::copy(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../libcalibre/tests/fixtures/empty_library/metadata.db"
        ),
        directory.path().join("metadata.db"),
    )
    .unwrap();
    let database = libcalibre::util::get_db_path(directory.path().to_str().unwrap()).unwrap();
    let mut library = Library::new(database).unwrap();
    let source = directory.path().join("source.txt");
    std::fs::write(&source, "HTTP contract").unwrap();
    let book = library
        .add_book(BookAdd {
            title: "Shared Contract".into(),
            author_names: vec!["Test Author".into()],
            tags: Some(vec!["Reference".into()]),
            series: Some("Contracts".into()),
            series_index: None,
            publisher: None,
            publication_date: None,
            rating: None,
            comments: None,
            identifiers: Default::default(),
            language: None,
            file_paths: vec![source],
        })
        .unwrap();
    let cover = image::RgbImage::from_pixel(600, 900, image::Rgb([40, 80, 120]));
    let mut cover_bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut cover_bytes)
        .encode_image(&cover)
        .unwrap();
    library.set_book_cover(book.id, cover_bytes).unwrap();
    drop(library);
    let source = Arc::new(open(directory.path()).unwrap());
    let (_, access) = access(directory.path());
    let service = OpdsService::with_ephemeral_credentials(
        source.clone(),
        vec![OpdsCredentialSecret {
            username: "reader".into(),
            password: "secret".into(),
        }],
    )
    .unwrap();
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    service
        .start(OpdsStartConfig {
            port: u32::from(port),
            authentication_enabled: true,
            target: OpdsBindTarget::Addresses {
                addresses: vec!["127.0.0.1".into()],
            },
        })
        .await
        .unwrap();
    let staging = api::Staging::open(directory.path().join("state/uploads"), uploads).unwrap();
    let router = api::router(source, &service, access, None, staging, metadata);
    let (status, cookie, _) = sign_in(&router, "reader", "secret-password").await;
    assert_eq!(status, StatusCode::OK);
    (
        directory,
        service,
        router,
        book.id.as_i32().to_string(),
        cookie.unwrap(),
    )
}

async fn request(
    router: &Router,
    method: &str,
    path: &str,
    body: String,
    cookie: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    let body = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    (status, headers, body)
}

fn query(limit: Value) -> Value {
    json!({"text":null,"author_id":null,"series_id":null,"tag_id":null,"publisher_id":null,"hide_read":false,"sort":"TitleAsc","limit":limit,"offset":0})
}

#[tokio::test]
async fn http_reads_match_shared_operations_without_changing_database() {
    let (directory, service, router, id, cookie) = fixture().await;
    let database_path = directory.path().join("metadata.db");
    let before = std::fs::read(&database_path).unwrap();
    let database = libcalibre::util::get_db_path(directory.path().to_str().unwrap()).unwrap();
    let mut library = Library::open_read_only(database).unwrap();
    let urls = HttpUrlBuilder::new("");
    let mut core = LibraryService::new(&mut library, &urls);
    let input = query(json!(50));
    let expected = core
        .query_books(serde_json::from_value::<LibraryBookQuery>(input.clone()).unwrap())
        .unwrap();
    let (status, _, actual) = request(
        &router,
        "POST",
        "/api/books/query",
        input.to_string(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{actual}");
    assert_eq!(actual, serde_json::to_value(expected).unwrap());
    let (status, _, actual) = request(
        &router,
        "GET",
        &format!("/api/books/{id}"),
        String::new(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        actual,
        serde_json::to_value(core.get_book(&id).unwrap()).unwrap()
    );
    assert!(!actual
        .to_string()
        .contains(directory.path().to_str().unwrap()));
    assert_eq!(std::fs::read(database_path).unwrap(), before);
    service.stop().await;
}

#[tokio::test]
async fn api_auth_errors_bounds_and_schema_are_consistent() {
    let (_directory, service, router, _, cookie) = fixture().await;
    let (status, headers, error) =
        request(&router, "GET", "/api/openapi.json", String::new(), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // A Basic challenge would make browsers show their own sign-in dialog.
    assert!(!headers.contains_key("www-authenticate"));
    assert_eq!(error["code"], "unauthorized");
    let basic = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/library")
                .header(
                    "authorization",
                    format!("Basic {}", STANDARD.encode("reader:secret-password")),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(basic.status(), StatusCode::UNAUTHORIZED);
    let (status, _, schema) = request(
        &router,
        "GET",
        "/api/openapi.json",
        String::new(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(schema, serde_json::to_value(api::openapi()).unwrap());
    assert_eq!(
        schema["components"]["securitySchemes"]["session"],
        json!({"type": "apiKey", "in": "cookie", "name": "citadel_session"})
    );
    for (method, path, body, expected, code) in [
        (
            "GET",
            "/api/books/bad",
            String::new(),
            400,
            "invalidArgument",
        ),
        ("GET", "/api/books/99999", String::new(), 404, "notFound"),
        (
            "POST",
            "/api/books/query",
            "{".into(),
            400,
            "invalidArgument",
        ),
        (
            "POST",
            "/api/books/query",
            query(Value::Null).to_string(),
            400,
            "invalidArgument",
        ),
        (
            "POST",
            "/api/books/query",
            query(json!(201)).to_string(),
            400,
            "invalidArgument",
        ),
        (
            "DELETE",
            "/api/books/1",
            String::new(),
            405,
            "invalidArgument",
        ),
    ] {
        let (status, _, error) = request(&router, method, path, body, Some(&cookie)).await;
        assert_eq!(status.as_u16(), expected, "{error}");
        assert_eq!(error["code"], code);
    }
    let (status, _, count) = request(
        &router,
        "POST",
        "/api/books/query",
        query(json!(0)).to_string(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{count}");
    assert_eq!(count["total"], 1);
    assert_eq!(count["items"], json!([]));
    // JSON bodies are bounded by the API, not by OPDS's catalog limit.
    let mut padded = query(json!(0));
    padded["text"] = json!(" ".repeat(64 * 1024));
    let (status, _, _) = request(
        &router,
        "POST",
        "/api/books/query",
        padded.to_string(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, error) = request(
        &router,
        "POST",
        "/api/books/query",
        "x".repeat(1024 * 1024 + 1),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(error["code"], "tooLarge");
    service.stop().await;
}

async fn asset_request(
    router: &Router,
    method: &str,
    path: &str,
    range: Option<&str>,
    cookie: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, axum::body::Bytes) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    if let Some(range) = range {
        request = request.header("range", range);
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    (status, headers, bytes)
}

#[tokio::test]
async fn browser_descriptor_facets_and_thumbnail_reads_are_protected_and_path_free() {
    let (directory, service, router, id, cookie) = fixture().await;
    let before = std::fs::read(directory.path().join("metadata.db")).unwrap();
    for path in [
        "/api/library",
        "/api/authors",
        "/api/series",
        "/api/tags",
        "/api/publishers",
        "/api/custom-columns",
        "/api/covers/thumbnails",
    ] {
        let (status, _, _) = request(&router, "GET", path, String::new(), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
        let (status, _, value) = request(&router, "GET", path, String::new(), Some(&cookie)).await;
        assert_eq!(status, StatusCode::OK, "{path}: {value}");
        assert!(!value
            .to_string()
            .contains(directory.path().to_str().unwrap()));
        match path {
            "/api/library" => {
                assert!(value["id"].as_str().is_some_and(|id| !id.is_empty()));
                assert_eq!(value["readOnly"], true);
            }
            "/api/authors" => assert_eq!(value[0]["name"], "Test Author"),
            "/api/series" => assert_eq!(value[0]["name"], "Contracts"),
            "/api/tags" => assert_eq!(value[0]["name"], "Reference"),
            "/api/publishers" => assert_eq!(value, json!([])),
            _ => {}
        }
    }
    let input = json!({"book_ids": [id, "99999"]});
    let (status, _, thumbnails) = request(
        &router,
        "POST",
        "/api/covers/thumbnails",
        input.to_string(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{thumbnails}");
    assert_eq!(thumbnails.as_array().unwrap().len(), 1);
    assert_eq!(thumbnails[0]["width"], 300);
    assert_eq!(thumbnails[0]["height"], 450);
    let url = thumbnails[0]["url"].as_str().unwrap();
    let (status, _, _) = asset_request(&router, "GET", url, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, headers, bytes) = asset_request(&router, "GET", url, None, Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "image/jpeg");
    let image = image::load_from_memory(&bytes).unwrap();
    assert_eq!((image.width(), image.height()), (300, 450));
    let (_, _, cached) = request(
        &router,
        "GET",
        "/api/covers/thumbnails",
        String::new(),
        Some(&cookie),
    )
    .await;
    assert_eq!(cached, thumbnails);
    for input in [
        json!({"book_ids": vec!["1"; 201]}),
        json!({"book_ids": ["../1"]}),
    ] {
        let (status, _, _) = request(
            &router,
            "POST",
            "/api/covers/thumbnails",
            input.to_string(),
            Some(&cookie),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let (status, _, values) = request(
        &router,
        "GET",
        &format!("/api/books/{id}/custom-values"),
        String::new(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(values, json!([]));
    let (status, _, _) = request(
        &router,
        "GET",
        "/api/books/99999/custom-values",
        String::new(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        std::fs::read(directory.path().join("metadata.db")).unwrap(),
        before
    );
    service.stop().await;
}

#[tokio::test]
async fn returned_browser_asset_urls_support_authenticated_downloads_head_and_range() {
    let (_directory, service, router, id, cookie) = fixture().await;
    let (_, _, book) = request(
        &router,
        "GET",
        &format!("/api/books/{id}"),
        String::new(),
        Some(&cookie),
    )
    .await;
    let url = book["file_list"][0]["Remote"]["url"].as_str().unwrap();
    let (status, _, _) = asset_request(&router, "GET", url, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, headers, bytes) = asset_request(&router, "GET", url, None, Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, "HTTP contract");
    assert!(headers["content-disposition"]
        .to_str()
        .unwrap()
        .contains("attachment"));
    let (status, head, bytes) = asset_request(&router, "HEAD", url, None, Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(head["content-length"], headers["content-length"]);
    assert!(bytes.is_empty());
    let (status, headers, bytes) =
        asset_request(&router, "GET", url, Some("bytes=0-3"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(headers["content-range"], "bytes 0-3/13");
    assert_eq!(bytes, "HTTP");
    let (status, headers, _) =
        asset_request(&router, "GET", url, Some("bytes=99-100"), Some(&cookie)).await;
    assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(headers["content-range"], "bytes */13");
    let cover_url = book["cover_image"]["url"].as_str().unwrap();
    let (status, headers, bytes) =
        asset_request(&router, "GET", cover_url, None, Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "image/jpeg");
    assert!(image::load_from_memory(&bytes).is_ok());
    for path in [
        format!("/api/books/{id}/files/%2E%2E/metadata.db"),
        format!("/api/books/{id}/files/epub/metadata.db"),
        "/api/books/99999/cover".into(),
    ] {
        let (status, _, _) = asset_request(&router, "GET", &path, None, Some(&cookie)).await;
        assert!(status.is_client_error(), "{path}: {status}");
    }
    service.stop().await;
}

#[tokio::test]
async fn browser_hosting_serves_the_frontend_publicly_and_only_falls_back_for_html_routes() {
    let (directory, service, _, _, cookie) = fixture().await;
    let web = directory.path().join("web");
    std::fs::create_dir_all(web.join("assets")).unwrap();
    std::fs::write(web.join("index.html"), "<html>Citadel frontend</html>").unwrap();
    std::fs::write(web.join("assets/app.js"), "window.citadel = true;").unwrap();
    let source = Arc::new(CalibreCatalogSource::open(directory.path()).unwrap());
    let (_, access) = access(directory.path());
    let staging = api::Staging::open(
        directory.path().join("state/uploads"),
        api::UploadConfig::default(),
    )
    .unwrap();
    let router = api::router(source, &service, access, Some(&web), staging, metadata());
    // The frontend is public so signed-out browsers can load the sign-in page.
    for (path, accept_html, expected, expected_body) in [
        ("/", true, 200, Some("<html>Citadel frontend</html>")),
        ("/books/1", true, 200, Some("<html>Citadel frontend</html>")),
        ("/assets/app.js", false, 200, Some("window.citadel = true;")),
        ("/assets/missing.js", true, 404, None),
        ("/api/missing", true, 404, None),
        ("/books/1", false, 404, None),
        ("/%2e%2e/metadata.db", true, 404, None),
    ] {
        let mut request = Request::builder().uri(path);
        if accept_html {
            request = request.header("accept", "text/html");
        }
        let response = router
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), expected, "{path}");
        assert!(!response.headers().contains_key("www-authenticate"));
        let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        if let Some(expected) = expected_body {
            assert_eq!(body, expected, "{path}");
        }
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(directory.path().join("metadata.db"), web.join("outside.db"))
            .unwrap();
        let (status, _, _) =
            asset_request(&router, "GET", "/outside.db", None, Some(&cookie)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    service.stop().await;
}

fn book_count(directory: &std::path::Path) -> usize {
    let database = libcalibre::util::get_db_path(directory.to_str().unwrap()).unwrap();
    Library::open_read_only(database)
        .unwrap()
        .books()
        .unwrap()
        .len()
}

#[tokio::test]
async fn read_only_library_refuses_deletes_and_keeps_every_byte() {
    let (directory, service, router, id, cookie) = fixture().await;
    let database_path = directory.path().join("metadata.db");
    let before = std::fs::read(&database_path).unwrap();
    let (status, _, library) =
        request(&router, "GET", "/api/library", String::new(), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(library["readOnly"], true);
    let (status, _, error) = request(
        &router,
        "POST",
        "/api/books/delete",
        json!({"book_ids": [id]}).to_string(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], "readOnly");
    let (status, _, error) = request(
        &router,
        "DELETE",
        "/api/authors/1",
        String::new(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["code"], "readOnly");
    assert_eq!(std::fs::read(database_path).unwrap(), before);
    assert!(directory.path().join("Test Author").is_dir());
    service.stop().await;
}

#[tokio::test]
async fn writable_library_deletes_books_and_their_folders_permanently() {
    let (directory, service, router, id, cookie) = fixture_opened(
        CalibreCatalogSource::open_writable,
        api::UploadConfig::default(),
    )
    .await;
    let (status, _, library) =
        request(&router, "GET", "/api/library", String::new(), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(library["readOnly"], false);
    let author_dir = directory.path().join("Test Author");
    assert!(author_dir.is_dir());

    let (status, _, _) = request(
        &router,
        "POST",
        "/api/books/delete",
        json!({"book_ids": [id]}).to_string(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let cross_origin = Request::builder()
        .method("POST")
        .uri("/api/books/delete")
        .header("content-type", "application/json")
        .header("origin", "https://elsewhere.example.com")
        .header("cookie", &cookie)
        .body(Body::from(json!({"book_ids": [id]}).to_string()))
        .unwrap();
    let response = router.clone().oneshot(cross_origin).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let (status, _, error) = request(
        &router,
        "POST",
        "/api/books/delete",
        json!({"book_ids": [id, "999999"]}).to_string(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{error}");
    assert_eq!(book_count(directory.path()), 1);
    assert!(author_dir.is_dir());

    let (status, _, authors) =
        request(&router, "GET", "/api/authors", String::new(), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let author_id = authors[0]["id"].as_str().unwrap().to_string();
    let (status, _, error) = request(
        &router,
        "DELETE",
        &format!("/api/authors/{author_id}"),
        String::new(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");

    let (status, _, outcome) = request(
        &router,
        "POST",
        "/api/books/delete",
        json!({"book_ids": [id]}).to_string(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{outcome}");
    assert_eq!(outcome, json!({"deleted": 1, "folder_failures": []}));
    assert_eq!(book_count(directory.path()), 0);
    assert!(!author_dir.exists());
    assert!(!directory.path().join(".caltrash").exists());

    let (status, _, body) = request(
        &router,
        "DELETE",
        &format!("/api/authors/{author_id}"),
        String::new(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let (_, _, authors) =
        request(&router, "GET", "/api/authors", String::new(), Some(&cookie)).await;
    assert_eq!(authors, json!([]));
    service.stop().await;
}

#[test]
fn committed_openapi_matches_routes() {
    let committed: Value = serde_json::from_str(include_str!("../../../api/openapi.json")).unwrap();
    assert_eq!(
        committed,
        serde_json::to_value(api::openapi()).unwrap(),
        "Run bun api:generate"
    );
}

#[tokio::test]
async fn missing_cover_does_not_fail_other_thumbnails() {
    let (directory, service, router, valid_id, cookie) = fixture().await;
    let database = libcalibre::util::get_db_path(directory.path().to_str().unwrap()).unwrap();
    let mut library = Library::new(database).unwrap();
    let missing = library
        .add_book(BookAdd {
            title: "Missing cover".into(),
            author_names: vec!["Test Author".into()],
            tags: None,
            series: None,
            series_index: None,
            publisher: None,
            publication_date: None,
            rating: None,
            comments: None,
            identifiers: Default::default(),
            language: None,
            file_paths: vec![],
        })
        .unwrap();
    let image = image::RgbImage::from_pixel(10, 10, image::Rgb([40, 80, 120]));
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut bytes)
        .encode_image(&image)
        .unwrap();
    library.set_book_cover(missing.id, bytes).unwrap();
    let cover = library.resolve_book_cover(missing.id).unwrap();
    std::fs::remove_file(cover.canonical_path()).unwrap();
    drop(library);
    let (status, _, thumbnails) = request(
        &router,
        "POST",
        "/api/covers/thumbnails",
        json!({"book_ids": [valid_id, missing.id.as_i32().to_string()]}).to_string(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{thumbnails}");
    assert_eq!(thumbnails.as_array().unwrap().len(), 1);
    assert_eq!(thumbnails[0]["book_id"], valid_id);
    service.stop().await;
}

async fn session_request(
    router: &Router,
    method: &str,
    cookie: Option<&str>,
    origin: Option<&str>,
) -> axum::response::Response {
    let mut request = Request::builder().method(method).uri("/api/session");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    if let Some(origin) = origin {
        request = request.header("origin", origin);
    }
    router
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn browser_sessions_sign_in_report_the_user_and_sign_out() {
    let (directory, service, router, _, cookie) = fixture().await;
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"username": "Reader", "password": "secret-password"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let set_cookie = response.headers()["set-cookie"].to_str().unwrap();
    for attribute in [
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
        "Secure",
        "Max-Age=2592000",
    ] {
        assert!(set_cookie.contains(attribute), "{set_cookie}");
    }

    let (status, _, session) =
        request(&router, "GET", "/api/session", String::new(), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["user"]["username"], "reader");
    assert_eq!(session["libraryAccess"], true);
    let (_, _, library) =
        request(&router, "GET", "/api/library", String::new(), Some(&cookie)).await;
    let (accounts, access) = access(directory.path());
    assert_eq!(library["id"], access.library_id);

    let (status, _, error) = request(&router, "GET", "/api/session", String::new(), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error["code"], "unauthorized");
    let (status, _, error) = sign_in(&router, "reader", "wrong-password").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error["message"], "Incorrect username or password");

    let refused = session_request(
        &router,
        "DELETE",
        Some(&cookie),
        Some("https://evil.example"),
    )
    .await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let signed_out = session_request(&router, "DELETE", Some(&cookie), Some(PUBLIC_URL)).await;
    assert_eq!(signed_out.status(), StatusCode::NO_CONTENT);
    assert!(signed_out.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
    let (status, headers, _) =
        request(&router, "GET", "/api/library", String::new(), Some(&cookie)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(headers["set-cookie"]
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
    drop(accounts);
    service.stop().await;
}

#[tokio::test]
async fn users_without_a_grant_cannot_see_the_library_and_cross_origin_sign_in_is_refused() {
    let (directory, service, router, id, _) = fixture().await;
    let (accounts, _) = access(directory.path());
    accounts.create_user("kid", "kid-password").unwrap();
    let (status, cookie, session) = sign_in(&router, "kid", "kid-password").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["libraryAccess"], false);
    let cookie = cookie.unwrap();
    for path in [
        "/api/library".to_string(),
        format!("/api/books/{id}"),
        format!("/api/books/{id}/cover"),
    ] {
        let (status, _, _) = asset_request(&router, "GET", &path, None, Some(&cookie)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }

    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session")
                .header("content-type", "application/json")
                .header("origin", "https://evil.example")
                .body(Body::from(
                    json!({"username": "reader", "password": "secret-password"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(!response.headers().contains_key("set-cookie"));
    service.stop().await;
}

fn small_uploads() -> api::UploadConfig {
    api::UploadConfig {
        max_file_bytes: 1024 * 1024,
        chunk_bytes: 4096,
        max_staged_bytes: 2 * 1024 * 1024,
        max_uploads_per_user: 2,
    }
}

/// An EPUB with a title, two authors and a noisy cover, so it spans several
/// small chunks.
fn epub_bytes() -> Vec<u8> {
    use std::io::Write;
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let mut cover = image::RgbImage::new(240, 360);
    for (x, y, pixel) in cover.enumerate_pixels_mut() {
        *pixel = image::Rgb([(x * 7 ^ y * 13) as u8, (x * y) as u8, (y * 3) as u8]);
    }
    let mut cover_bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cover_bytes, 95)
        .encode_image(&cover)
        .unwrap();
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/epub+zip").unwrap();
    zip.start_file("META-INF/container.xml", stored).unwrap();
    zip.write_all(br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
    zip.start_file("content.opf", stored).unwrap();
    zip.write_all(br#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:isbn:9780000000002</dc:identifier><dc:title>Uploaded Book</dc:title><dc:creator>First Author</dc:creator><dc:creator>Second Author</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/></manifest><spine><itemref idref="text"/></spine></package>"#).unwrap();
    zip.start_file("text.xhtml", stored).unwrap();
    zip.write_all(b"<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>Text</p></body></html>")
        .unwrap();
    zip.start_file("cover.jpg", stored).unwrap();
    zip.write_all(&cover_bytes).unwrap();
    zip.finish().unwrap().into_inner()
}

async fn send_chunk(
    router: &Router,
    cookie: &str,
    id: &str,
    offset: usize,
    bytes: Vec<u8>,
) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/uploads/{id}/content"))
                .header("cookie", cookie)
                .header("content-type", "application/octet-stream")
                .header("upload-offset", offset.to_string())
                .body(Body::from(bytes))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

async fn start_upload(
    router: &Router,
    cookie: &str,
    name: &str,
    size: usize,
) -> (StatusCode, Value) {
    let (status, _, body) = request(
        router,
        "POST",
        "/api/uploads",
        json!({"fileName": name, "size": size}).to_string(),
        Some(cookie),
    )
    .await;
    (status, body)
}

#[tokio::test]
async fn uploads_stream_in_chunks_and_offer_metadata_and_cover_for_review() {
    let (directory, service, router, _, cookie) = fixture_with(small_uploads()).await;
    let epub = epub_bytes();
    assert!(epub.len() > 3 * 4096, "fixture spans several chunks");

    let (status, _, limits) =
        request(&router, "GET", "/api/uploads", String::new(), Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(limits["chunkBytes"], 4096);
    assert_eq!(limits["maxFileBytes"], 1024 * 1024);
    assert_eq!(limits["uploads"], json!([]));

    let (status, upload) =
        start_upload(&router, &cookie, "C:\\Books\\uploaded.EPUB", epub.len()).await;
    assert_eq!(status, StatusCode::CREATED, "{upload}");
    assert_eq!(upload["fileName"], "uploaded.EPUB");
    assert_eq!(upload["receivedBytes"], 0);
    assert_eq!(upload["book"], Value::Null);
    let id = upload["id"].as_str().unwrap().to_string();

    let mut last = Value::Null;
    for (index, chunk) in epub.chunks(4096).enumerate() {
        let (status, body) = send_chunk(&router, &cookie, &id, index * 4096, chunk.to_vec()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["receivedBytes"], index * 4096 + chunk.len());
        last = body;
    }
    let book = &last["book"];
    assert_eq!(book["format"], "epub");
    assert_eq!(book["title"], "Uploaded Book");
    assert_eq!(
        book["authorNames"],
        json!(["First Author", "Second Author"])
    );
    assert_eq!(book["identifier"], "urn:isbn:9780000000002");
    assert_eq!(book["coverUrl"], format!("/api/uploads/{id}/cover"));
    assert!(!last
        .to_string()
        .contains(directory.path().to_str().unwrap()));

    let cover = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/uploads/{id}/cover"))
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cover.status(), StatusCode::OK);
    assert_eq!(cover.headers()["content-type"], "image/jpeg");
    let preview = to_bytes(cover.into_body(), 1024 * 1024).await.unwrap();
    assert!(image::load_from_memory(&preview).is_ok());

    let (status, done) = send_chunk(&router, &cookie, &id, epub.len(), vec![1]).await;
    assert_eq!(
        (status, done["code"].as_str()),
        (StatusCode::CONFLICT, Some("conflict"))
    );

    let staged = directory.path().join(format!("state/uploads/{id}.epub"));
    assert_eq!(std::fs::read(&staged).unwrap(), epub);
    let (status, _, _) = request(
        &router,
        "DELETE",
        &format!("/api/uploads/{id}"),
        String::new(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(!staged.exists());
    let (status, _, _) = request(
        &router,
        "GET",
        &format!("/api/uploads/{id}"),
        String::new(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    service.stop().await;
}

#[tokio::test]
async fn chunks_must_continue_at_the_offset_and_fit_the_chunk_size() {
    let (directory, service, router, _, cookie) = fixture_with(small_uploads()).await;
    let epub = epub_bytes();
    let (_, upload) = start_upload(&router, &cookie, "book.epub", epub.len()).await;
    let id = upload["id"].as_str().unwrap().to_string();

    let (status, error) = send_chunk(&router, &cookie, &id, 4096, epub[..4096].to_vec()).await;
    assert_eq!(
        (status, error["code"].as_str()),
        (StatusCode::CONFLICT, Some("conflict"))
    );
    assert!(error["message"].as_str().unwrap().contains("byte 0"));

    let (status, error) = send_chunk(&router, &cookie, &id, 0, epub[..4097].to_vec()).await;
    assert_eq!(
        (status, error["code"].as_str()),
        (StatusCode::PAYLOAD_TOO_LARGE, Some("tooLarge"))
    );

    // A chunk cut off partway leaves nothing behind, so it can be resent.
    let interrupted = futures_util::stream::iter([
        Ok::<_, std::io::Error>(epub[..2048].to_vec()),
        Err(std::io::Error::other("connection reset")),
    ]);
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/uploads/{id}/content"))
                .header("cookie", &cookie)
                .header("upload-offset", "0")
                .body(Body::from_stream(interrupted))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let staged = directory.path().join(format!("state/uploads/{id}.epub"));
    assert_eq!(std::fs::metadata(&staged).unwrap().len(), 0);
    let (_, status_body, current) = request(
        &router,
        "GET",
        &format!("/api/uploads/{id}"),
        String::new(),
        Some(&cookie),
    )
    .await;
    assert_eq!(current["receivedBytes"], 0, "{status_body:?}");

    let (status, body) = send_chunk(&router, &cookie, &id, 0, epub[..4096].to_vec()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["receivedBytes"], 4096);
    service.stop().await;
}

#[tokio::test]
async fn uploads_reject_unsupported_mislabelled_and_oversized_files() {
    let (_directory, service, router, _, cookie) = fixture_with(small_uploads()).await;
    let (status, error) = start_upload(&router, &cookie, "archive.zip", 10).await;
    assert_eq!(
        (status, error["code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalidArgument"))
    );
    let (status, error) = start_upload(&router, &cookie, "huge.pdf", 1024 * 1024 + 1).await;
    assert_eq!(
        (status, error["code"].as_str()),
        (StatusCode::PAYLOAD_TOO_LARGE, Some("tooLarge"))
    );
    let (status, _) = start_upload(&router, &cookie, "empty.txt", 0).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A PDF named as an EPUB is refused on its first chunk and discarded.
    let pdf = b"%PDF-1.7 not really an epub".to_vec();
    let (_, upload) = start_upload(&router, &cookie, "book.epub", pdf.len()).await;
    let id = upload["id"].as_str().unwrap().to_string();
    let (status, error) = send_chunk(&router, &cookie, &id, 0, pdf).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["message"].as_str().unwrap().contains("EPUB"));
    let (status, _, _) = request(
        &router,
        "GET",
        &format!("/api/uploads/{id}"),
        String::new(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A file without readable metadata is still offered, titled by its name.
    let (_, upload) = start_upload(&router, &cookie, "Field Notes.pdf", 9).await;
    let id = upload["id"].as_str().unwrap().to_string();
    let (status, body) = send_chunk(&router, &cookie, &id, 0, b"%PDF-1.7\n".to_vec()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["book"]["title"], "Field Notes");
    assert_eq!(body["book"]["coverUrl"], Value::Null);

    // Each user may hold two uploads at once.
    let (status, _) = start_upload(&router, &cookie, "second.txt", 5).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, error) = start_upload(&router, &cookie, "third.txt", 5).await;
    assert_eq!(
        (status, error["code"].as_str()),
        (StatusCode::INSUFFICIENT_STORAGE, Some("storageFull"))
    );
    service.stop().await;
}

#[tokio::test]
async fn staged_space_is_reserved_when_an_upload_starts() {
    let mut uploads = small_uploads();
    uploads.max_uploads_per_user = 10;
    let (_directory, service, router, _, cookie) = fixture_with(uploads).await;
    let (status, _) = start_upload(&router, &cookie, "one.pdf", 1024 * 1024).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = start_upload(&router, &cookie, "two.pdf", 1024 * 1024).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, error) = start_upload(&router, &cookie, "three.pdf", 1).await;
    assert_eq!(
        (status, error["code"].as_str()),
        (StatusCode::INSUFFICIENT_STORAGE, Some("storageFull"))
    );
    service.stop().await;
}

#[tokio::test]
async fn uploads_belong_to_their_user_and_require_a_same_origin_session() {
    let (directory, service, router, _, cookie) = fixture_with(small_uploads()).await;
    let (_, upload) = start_upload(&router, &cookie, "mine.txt", 5).await;
    let id = upload["id"].as_str().unwrap().to_string();

    let (accounts, _) = access(directory.path());
    let library_id = accounts.libraries().unwrap()[0].id.clone();
    accounts.create_user("other", "other-password").unwrap();
    accounts.grant("other", &library_id).unwrap();
    let (_, other, _) = sign_in(&router, "other", "other-password").await;
    let other = other.unwrap();
    for (method, path) in [
        ("GET", format!("/api/uploads/{id}")),
        ("DELETE", format!("/api/uploads/{id}")),
        ("GET", format!("/api/uploads/{id}/cover")),
    ] {
        let (status, _, _) = request(&router, method, &path, String::new(), Some(&other)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
    }
    let (status, _) = send_chunk(&router, &other, &id, 0, b"hello".to_vec()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, _, list) = request(&router, "GET", "/api/uploads", String::new(), Some(&other)).await;
    assert_eq!(list["uploads"], json!([]));

    let (status, _) = send_chunk(&router, "citadel_session=nope", &id, 0, b"hello".to_vec()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/uploads/{id}/content"))
                .header("cookie", &cookie)
                .header("origin", "https://elsewhere.example")
                .header("upload-offset", "0")
                .body(Body::from("hello"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    service.stop().await;
}

#[test]
fn opening_the_staging_area_clears_files_from_earlier_runs() {
    let directory = tempfile::tempdir().unwrap();
    let uploads = directory.path().join("uploads");
    std::fs::create_dir_all(uploads.join("nested")).unwrap();
    std::fs::write(uploads.join("0123.epub"), b"left over").unwrap();
    api::Staging::open(uploads.clone(), api::UploadConfig::default()).unwrap();
    assert_eq!(std::fs::read_dir(&uploads).unwrap().count(), 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&uploads).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }
}

async fn upload_whole(router: &Router, cookie: &str, name: &str, bytes: &[u8]) -> Value {
    let (status, upload) = start_upload(router, cookie, name, bytes.len()).await;
    assert_eq!(status, StatusCode::CREATED, "{upload}");
    let id = upload["id"].as_str().unwrap().to_string();
    let mut last = upload;
    for (index, chunk) in bytes.chunks(4096).enumerate() {
        let (status, body) = send_chunk(router, cookie, &id, index * 4096, chunk.to_vec()).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        last = body;
    }
    last
}

#[tokio::test]
async fn committing_an_upload_adds_it_to_the_library_with_the_reviewed_metadata() {
    let (directory, service, router, _, cookie) =
        fixture_opened(CalibreCatalogSource::open_writable, small_uploads()).await;
    let staged = upload_whole(&router, &cookie, "uploaded.epub", &epub_bytes()).await;
    let id = staged["id"].as_str().unwrap().to_string();

    let commit = json!({
        "title": "  Reviewed Title ",
        "authorNames": ["First Author", " ", "Third Author"],
        "identifier": "urn:isbn:978-0-00-000000-2",
        "publisher": "Small Press",
        "language": "en",
        "tags": ["Fiction", ""],
        "publicationDate": "2021-03-04"
    });
    let (status, _, book) = request(
        &router,
        "POST",
        &format!("/api/uploads/{id}/commit"),
        commit.to_string(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{book}");
    assert_eq!(book["title"], "Reviewed Title");
    let authors: Vec<&str> = book["author_list"]
        .as_array()
        .unwrap()
        .iter()
        .map(|author| author["name"].as_str().unwrap())
        .collect();
    assert_eq!(authors, ["First Author", "Third Author"]);
    assert!(book.to_string().contains("9780000000002"), "{book}");
    let (_, _, publishers) = request(
        &router,
        "GET",
        "/api/publishers",
        String::new(),
        Some(&cookie),
    )
    .await;
    assert!(
        publishers.to_string().contains("Small Press"),
        "{publishers}"
    );
    assert!(!book
        .to_string()
        .contains(directory.path().to_str().unwrap()));

    // The library now holds the file and its cover; staging is empty.
    let book_id = book["id"].as_str().unwrap();
    let (status, _, fetched) = request(
        &router,
        "GET",
        &format!("/api/books/{book_id}"),
        String::new(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{fetched}");
    assert!(
        fetched.to_string().contains("/files/EPUB/")
            || fetched.to_string().contains("/files/epub/"),
        "{fetched}"
    );
    let cover = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/books/{book_id}/cover"))
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cover.status(), StatusCode::OK);
    assert_eq!(
        std::fs::read_dir(directory.path().join("state/uploads"))
            .unwrap()
            .count(),
        0
    );
    let (status, _, _) = request(
        &router,
        "GET",
        &format!("/api/uploads/{id}"),
        String::new(),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    service.stop().await;
}

#[tokio::test]
async fn commits_need_a_finished_upload_a_title_its_owner_and_a_writable_library() {
    let (directory, service, router, _, cookie) =
        fixture_opened(CalibreCatalogSource::open_writable, small_uploads()).await;
    let epub = epub_bytes();
    let (_, upload) = start_upload(&router, &cookie, "partial.epub", epub.len()).await;
    let partial = upload["id"].as_str().unwrap().to_string();
    let commit = |title: &str| json!({"title": title}).to_string();
    let (status, _, error) = request(
        &router,
        "POST",
        &format!("/api/uploads/{partial}/commit"),
        commit("Book"),
        Some(&cookie),
    )
    .await;
    assert_eq!(
        (status, error["code"].as_str()),
        (StatusCode::CONFLICT, Some("conflict"))
    );

    let staged = upload_whole(&router, &cookie, "whole.epub", &epub).await;
    let id = staged["id"].as_str().unwrap().to_string();
    let (status, _, _) = request(
        &router,
        "POST",
        &format!("/api/uploads/{id}/commit"),
        commit("  "),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (accounts, _) = access(directory.path());
    let library_id = accounts.libraries().unwrap()[0].id.clone();
    accounts.create_user("other", "other-password").unwrap();
    accounts.grant("other", &library_id).unwrap();
    let (_, other, _) = sign_in(&router, "other", "other-password").await;
    let (status, _, _) = request(
        &router,
        "POST",
        &format!("/api/uploads/{id}/commit"),
        commit("Book"),
        other.as_deref(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A failed commit leaves the upload in place to try again.
    let (status, _, book) = request(
        &router,
        "POST",
        &format!("/api/uploads/{id}/commit"),
        commit("Book"),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{book}");
    service.stop().await;

    let (_directory, service, router, _, cookie) =
        fixture_opened(CalibreCatalogSource::open, small_uploads()).await;
    let (_, _, library) =
        request(&router, "GET", "/api/library", String::new(), Some(&cookie)).await;
    assert_eq!(library["readOnly"], true);
    let staged = upload_whole(&router, &cookie, "whole.epub", &epub).await;
    let id = staged["id"].as_str().unwrap().to_string();
    let (status, _, error) = request(
        &router,
        "POST",
        &format!("/api/uploads/{id}/commit"),
        commit("Book"),
        Some(&cookie),
    )
    .await;
    assert_eq!(
        (status, error["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("readOnly"))
    );
    service.stop().await;
}

/// Stands in for Open Library, counting the requests that reach it.
async fn fake_openlibrary() -> (String, Arc<std::sync::atomic::AtomicUsize>) {
    use axum::{extract::State, routing::get};
    let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let router = axum::Router::new()
        .route(
            "/search.json",
            get(
                |State(hits): State<Arc<std::sync::atomic::AtomicUsize>>,
                 axum::extract::RawQuery(query): axum::extract::RawQuery| async move {
                    hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if query.unwrap_or_default().contains("q=broken") {
                        return (StatusCode::BAD_GATEWAY, "upstream down").into_response();
                    }
                    axum::Json(json!({"docs": [{
                        "key": "/works/OL893415W", "title": "Dune", "author_name": ["Frank Herbert"],
                        "first_publish_year": 1965, "cover_i": 11481354, "edition_key": ["OL26242482M"]
                    }]}))
                    .into_response()
                },
            ),
        )
        .route(
            "/api/books",
            get(|State(hits): State<Arc<std::sync::atomic::AtomicUsize>>| async move {
                hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                axum::Json(json!({"ISBN:9780553103540": {"title": "A Game of Thrones", "key": "/books/OL7826547M"}}))
            }),
        )
        .route("/graphql", axum::routing::post(fake_hardcover))
        .route(
            "/img/cover.jpg",
            get(|| async {
                (
                    [("content-type", "image/jpeg")],
                    jpeg(Rgb([200, 30, 30]), 800, 1200),
                )
            }),
        )
        .with_state(hits.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await });
    (format!("http://{address}"), hits)
}

use axum::response::IntoResponse;
use image::Rgb;

fn jpeg(colour: Rgb<u8>, width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut bytes)
        .encode_image(&image::RgbImage::from_pixel(width, height, colour))
        .unwrap();
    bytes
}

async fn raw(
    router: &Router,
    method: &str,
    path: &str,
    body: Vec<u8>,
    content_type: &str,
    cookie: &str,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", content_type)
                .header("origin", PUBLIC_URL)
                .header("cookie", cookie)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let body = to_bytes(response.into_body(), 64 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    (status, headers, body)
}

/// Accepts only the token `good`, the way Hasura reports a bad JWT.
async fn fake_hardcover(
    headers: axum::http::HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> axum::Json<Value> {
    let host = headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        != Some("Bearer good")
    {
        return axum::Json(
            json!({"errors": [{"message": "Could not verify JWT: JWSError", "extensions": {"code": "invalid-jwt"}}]}),
        );
    }
    if body["query"].as_str().unwrap_or_default().contains("me {") {
        return axum::Json(json!({"data": {"me": [{"id": 7, "username": "reader-hc"}]}}));
    }
    axum::Json(
        json!({"data": {"search": {"ids": ["1"], "results": {"hits": [
            {"document": {"id": 1, "title": "Dune", "isbns": [], "contributions": [], "genres": [],
            "image": {"url": format!("http://{host}/img/cover.jpg")}}}
        ]}}}}),
    )
}

#[tokio::test]
async fn metadata_lookups_are_signed_in_cached_and_rate_limited_per_user() {
    let (base, hits) = fake_openlibrary().await;
    let config: api::MetadataConfig =
        serde_json::from_value(json!({"search": {"perUserPerMinute": 3}})).unwrap();
    let (_directory, service, router, _, cookie) = fixture_with_metadata(
        CalibreCatalogSource::open,
        api::UploadConfig::default(),
        metadata_at(base, config),
    )
    .await;
    let get = |path: &str, cookie: Option<&str>| {
        let path = path.to_string();
        let cookie = cookie.map(String::from);
        let router = router.clone();
        async move { request(&router, "GET", &path, String::new(), cookie.as_deref()).await }
    };

    let (status, _, _) = get("/api/metadata/search?provider=openlibrary&q=dune", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _, books) = get(
        "/api/metadata/search?provider=openlibrary&q=dune",
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{books}");
    assert_eq!(books[0]["title"], "Dune");
    assert_eq!(books[0]["provider"], "openlibrary");
    let (_, _, again) = get(
        "/api/metadata/search?provider=openlibrary&q=%20DUNE%20",
        Some(&cookie),
    )
    .await;
    assert_eq!(again, books);
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1, "cached");

    let (status, _, books) = get(
        "/api/metadata/isbn/0-553-10354-7?provider=openlibrary",
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{books}");
    assert_eq!(books[0]["isbn"], "0553103547");

    for (path, expected) in [
        (
            "/api/metadata/search?provider=nope&q=dune",
            StatusCode::BAD_REQUEST,
        ),
        ("/api/metadata/search?q=dune", StatusCode::BAD_REQUEST),
        (
            "/api/metadata/isbn/not-an-isbn?provider=loc",
            StatusCode::BAD_REQUEST,
        ),
        (
            "/api/metadata/search?provider=hardcover&q=dune",
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let (status, _, error) = get(path, Some(&cookie)).await;
        assert_eq!(status, expected, "{path}: {error}");
        assert_eq!(error["code"], "invalidArgument");
    }

    let (status, _, error) = get(
        "/api/metadata/search?provider=openlibrary&q=broken",
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(!error["message"].as_str().unwrap().contains("127.0.0.1"));

    let (status, headers, error) = get(
        "/api/metadata/search?provider=openlibrary&q=fourth",
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{error}");
    assert_eq!(error["code"], "rateLimited");
    assert_eq!(headers["retry-after"], "20");
    let (status, _, _) = get(
        "/api/metadata/search?provider=openlibrary&q=dune",
        Some(&cookie),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "cached answers don't spend the limit"
    );

    let (status, _, providers) = get("/api/metadata/providers", Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    let hardcover = providers
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["provider"] == "hardcover")
        .unwrap();
    assert_eq!(hardcover["requiresKey"], true);
    assert_eq!(hardcover["available"], false);
    let loc = providers
        .as_array()
        .unwrap()
        .iter()
        .find(|provider| provider["provider"] == "loc")
        .unwrap();
    assert_eq!(loc["available"], true);
    service.stop().await;
}

#[tokio::test]
async fn provider_keys_are_verified_saved_per_user_and_never_returned() {
    let (base, _) = fake_openlibrary().await;
    let (_directory, service, router, _, cookie) = fixture_with_metadata(
        CalibreCatalogSource::open,
        api::UploadConfig::default(),
        metadata_at(base, api::MetadataConfig::default()),
    )
    .await;
    let call = |method: &str, path: &str, body: Value| {
        let (method, path, router, cookie) = (
            method.to_string(),
            path.to_string(),
            router.clone(),
            cookie.clone(),
        );
        async move {
            let body = if body.is_null() {
                String::new()
            } else {
                body.to_string()
            };
            request(&router, &method, &path, body, Some(&cookie)).await
        }
    };
    let hardcover = |providers: &Value| {
        providers
            .as_array()
            .unwrap()
            .iter()
            .find(|provider| provider["provider"] == "hardcover")
            .unwrap()
            .clone()
    };

    let (_, _, providers) = call("GET", "/api/metadata/providers", Value::Null).await;
    assert_eq!(hardcover(&providers)["available"], false);
    assert!(hardcover(&providers)["unavailableReason"]
        .as_str()
        .unwrap()
        .contains("Account settings"));
    let (status, _, error) = call(
        "GET",
        "/api/metadata/search?provider=hardcover&q=dune",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");

    let key_path = "/api/account/provider-credentials/hardcover";
    let (status, _, error) = call("PUT", key_path, json!({"secret": "wrong"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(error["message"].as_str().unwrap().contains("didn't accept"));
    let (_, _, listed) = call("GET", "/api/account/provider-credentials", Value::Null).await;
    assert_eq!(listed, json!([]));

    let (status, _, saved) = call("PUT", key_path, json!({"secret": " Bearer good "})).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["accountName"], "reader-hc");
    assert_eq!(saved["needsReentry"], false);
    let (_, _, listed) = call("GET", "/api/account/provider-credentials", Value::Null).await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert!(!listed.to_string().contains("good"), "{listed}");

    let (_, _, providers) = call("GET", "/api/metadata/providers", Value::Null).await;
    assert_eq!(hardcover(&providers)["available"], true);
    let (status, _, books) = call(
        "GET",
        "/api/metadata/search?provider=hardcover&q=dune",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{books}");
    assert_eq!(books[0]["title"], "Dune");
    let (status, _, tested) = call(
        "POST",
        "/api/metadata/providers/hardcover/test",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tested["is_valid"], true);

    let (status, _, _) = call(
        "PUT",
        "/api/account/provider-credentials/loc",
        json!({"secret": "anything"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _, _) = call("DELETE", key_path, Value::Null).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _, _) = call("DELETE", key_path, Value::Null).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = call(
        "GET",
        "/api/metadata/search?provider=hardcover&q=dune2",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _, _) = request(
        &router,
        "GET",
        "/api/account/provider-credentials",
        String::new(),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    service.stop().await;
}

#[tokio::test]
async fn covers_are_previewed_and_applied_by_id_never_by_url() {
    let (base, _) = fake_openlibrary().await;
    let config: api::MetadataConfig =
        serde_json::from_value(json!({"maxImageBytes": 2 * 1024 * 1024})).unwrap();
    let (_directory, service, router, id, cookie) = fixture_with_metadata(
        CalibreCatalogSource::open_writable,
        api::UploadConfig::default(),
        metadata_at(base.clone(), config.clone()),
    )
    .await;
    let call = |method: &str, path: &str, body: Value| {
        let (method, path, router, cookie) = (
            method.to_string(),
            path.to_string(),
            router.clone(),
            cookie.clone(),
        );
        async move {
            let body = if body.is_null() {
                String::new()
            } else {
                body.to_string()
            };
            request(&router, &method, &path, body, Some(&cookie)).await
        }
    };
    let (status, _, _) = call(
        "PUT",
        "/api/account/provider-credentials/hardcover",
        json!({"secret": "good"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, _, books) = call(
        "GET",
        "/api/metadata/search?provider=hardcover&q=dune",
        Value::Null,
    )
    .await;
    assert!(!books.to_string().contains("127.0.0.1"), "{books}");
    let cover_id = books[0]["cover_id"].as_str().unwrap().to_string();

    let (status, headers, preview) = raw(
        &router,
        "GET",
        &format!("/api/metadata/covers/{cover_id}/preview"),
        Vec::new(),
        "application/json",
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "image/jpeg");
    assert_eq!(headers["cache-control"], "private, max-age=180");
    let decoded = image::load_from_memory(&preview).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (400, 600));

    let (status, _, _) = call(
        "POST",
        &format!("/api/metadata/covers/{cover_id}/prefetch"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let cover_path = format!("/api/books/{id}/cover");
    let (status, _, before) = raw(
        &router,
        "GET",
        &cover_path,
        Vec::new(),
        "application/json",
        &cookie,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "GET still served by the asset route"
    );
    let (status, _, error) = call("POST", &cover_path, json!({"coverId": cover_id})).await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{error}");
    let (_, _, after) = raw(
        &router,
        "GET",
        &cover_path,
        Vec::new(),
        "application/json",
        &cookie,
    )
    .await;
    assert_ne!(before, after);
    let applied = image::load_from_memory(&after).unwrap();
    assert_eq!((applied.width(), applied.height()), (800, 1200));

    for (body, expected) in [
        (
            json!({"coverId": "0123456789abcdef0123456789abcdef"}),
            StatusCode::GONE,
        ),
        (
            json!({"url": "https://example.com/x.jpg"}),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let (status, _, error) = call("POST", &cover_path, body).await;
        assert_eq!(status, expected, "{error}");
    }

    let mut png = Vec::new();
    image::RgbImage::from_pixel(30, 40, Rgb([10, 200, 10]))
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    let (status, _, _) = raw(&router, "PUT", &cover_path, png, "image/png", &cookie).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, _, uploaded) = raw(
        &router,
        "GET",
        &cover_path,
        Vec::new(),
        "application/json",
        &cookie,
    )
    .await;
    assert_eq!(&uploaded[..2], &[0xFF, 0xD8], "stored re-encoded as JPEG");
    let (status, _, _) = raw(
        &router,
        "PUT",
        &cover_path,
        b"<svg/>".to_vec(),
        "image/svg+xml",
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, _) = raw(
        &router,
        "PUT",
        &cover_path,
        vec![0; 3 * 1024 * 1024],
        "image/jpeg",
        &cookie,
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    service.stop().await;

    let (_directory, service, router, id, cookie) = fixture_with_metadata(
        CalibreCatalogSource::open,
        api::UploadConfig::default(),
        metadata_at(base, config),
    )
    .await;
    let (status, _, error) = request(
        &router,
        "POST",
        &format!("/api/books/{id}/cover"),
        json!({"coverId": cover_id}).to_string(),
        Some(&cookie),
    )
    .await;
    assert_eq!(
        (status, error["code"].as_str()),
        (StatusCode::FORBIDDEN, Some("readOnly"))
    );
    service.stop().await;
}
