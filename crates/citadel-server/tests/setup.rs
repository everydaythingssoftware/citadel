//! First-run setup through the API: the setup code makes the administrator,
//! the administrator chooses a library, readers stay out of the server's
//! folders, and the choice survives a restart.
use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use citadel_core::store::CitadelStore;
use citadel_opds::OpdsService;
use citadel_server::{
    api,
    served::{resolve, ServedLibrary},
    CalibreCatalogSource,
};
use serde_json::{json, Value};
use tower::ServiceExt;

const PUBLIC_URL: &str = "https://books.example.com";
const SETUP_CODE: &str = "K7QD-M2XV-H9RW";

struct Server {
    router: Router,
    accounts: Arc<CitadelStore>,
    served: Arc<ServedLibrary>,
    source: Arc<CalibreCatalogSource>,
    _service: OpdsService,
}

/// A server over `directory/state` with no library and no administrator, as
/// a fresh installation starts; `code` is what it would have printed.
fn fresh(directory: &std::path::Path, code: Option<&str>) -> Server {
    let state = directory.join("state");
    std::fs::create_dir_all(&state).unwrap();
    let accounts = Arc::new(CitadelStore::open(&state.join("citadel.db")).unwrap());
    let source = Arc::new(CalibreCatalogSource::empty());
    let served = Arc::new(ServedLibrary::new(
        accounts.clone(),
        source.clone(),
        state.clone(),
    ));
    served.open_registered().unwrap();
    let service = OpdsService::with_ephemeral_credentials(source.clone(), Vec::new()).unwrap();
    let access = api::ApiAccess {
        accounts: accounts.clone(),
        served: served.clone(),
        public_url: api::PublicUrl::parse(PUBLIC_URL).unwrap(),
        secrets: Arc::new(
            citadel_core::vault::Vault::open_or_create(&state.join("secrets")).unwrap(),
        ),
        setup_code: code.map(String::from),
    };
    let staging = api::Staging::open(state.join("uploads"), api::UploadConfig::default()).unwrap();
    let metadata = Arc::new(
        api::Metadata::new(api::MetadataConfig::default())
            .expect("metadata client builds without a network"),
    );
    let router = api::router(source.clone(), &service, access, None, staging, metadata);
    Server {
        router,
        accounts,
        served,
        source,
        _service: service,
    }
}

async fn request(
    router: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
    cookie: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("origin", PUBLIC_URL);
    if let Some(cookie) = cookie {
        builder = builder.header("cookie", cookie);
    }
    let request = match body {
        Some(body) => builder
            .header("content-type", "application/json")
            .body(Body::from(body.to_string())),
        None => builder.body(Body::empty()),
    }
    .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into_owned()))
    };
    (status, headers, value)
}

fn cookie(headers: &axum::http::HeaderMap) -> String {
    headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

async fn bootstrap(router: &Router) -> String {
    let (status, headers, session) = request(
        router,
        "POST",
        "/api/setup/administrator",
        Some(json!({"setupCode": SETUP_CODE, "username": "phil", "password": "a long password"})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{session}");
    assert_eq!(session["administrator"], true);
    assert_eq!(session["libraryAccess"], false);
    cookie(&headers)
}

#[tokio::test]
async fn a_fresh_server_bootstraps_its_administrator_with_the_setup_code() {
    let directory = tempfile::tempdir().unwrap();
    let server = fresh(directory.path(), Some(SETUP_CODE));
    let (status, _, setup) = request(&server.router, "GET", "/api/setup", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        setup,
        json!({"administratorExists": false, "libraryConfigured": false, "libraryAvailable": false})
    );

    let (status, _, error) = request(
        &server.router,
        "POST",
        "/api/setup/administrator",
        Some(json!({"setupCode": "WRONG-CODE-HERE", "username": "phil", "password": "a long password"})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(error["message"].as_str().unwrap().contains("setup code"));
    assert!(!server.accounts.administrator_exists().unwrap());

    let (status, _, error) = request(
        &server.router,
        "POST",
        "/api/setup/administrator",
        Some(json!({"setupCode": "k7qd m2xv h9rw", "username": "phil", "password": "short"})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");

    let cookie = bootstrap(&server.router).await;
    assert!(server.accounts.administrator_exists().unwrap());
    assert!(server.accounts.user("phil").unwrap().is_administrator());

    let (_, _, setup) = request(&server.router, "GET", "/api/setup", None, None).await;
    assert_eq!(setup["administratorExists"], true);
    let (status, _, error) = request(
        &server.router,
        "POST",
        "/api/setup/administrator",
        Some(json!({"setupCode": SETUP_CODE, "username": "again", "password": "a long password"})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");

    let (status, _, session) =
        request(&server.router, "GET", "/api/session", None, Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["administrator"], true);
    let (status, _, error) =
        request(&server.router, "GET", "/api/library", None, Some(&cookie)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error["message"], "No library is set up on this server yet");
}

#[tokio::test]
async fn wrong_setup_codes_back_off_like_sign_in() {
    let directory = tempfile::tempdir().unwrap();
    let server = fresh(directory.path(), Some(SETUP_CODE));
    let attempt = || {
        request(
            &server.router,
            "POST",
            "/api/setup/administrator",
            Some(
                json!({"setupCode": "AAAA-AAAA-AAAA", "username": "phil", "password": "a long password"}),
            ),
            None,
        )
    };
    for _ in 0..3 {
        assert_eq!(attempt().await.0, StatusCode::UNAUTHORIZED);
    }
    let (status, headers, _) = attempt().await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(headers["retry-after"], "2");
}

#[tokio::test]
async fn a_server_without_a_setup_code_has_an_administrator_already() {
    let directory = tempfile::tempdir().unwrap();
    let server = fresh(directory.path(), None);
    let (status, _, _) = request(
        &server.router,
        "POST",
        "/api/setup/administrator",
        Some(json!({"setupCode": SETUP_CODE, "username": "phil", "password": "a long password"})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn the_administrator_creates_a_library_and_the_server_serves_it() {
    let directory = tempfile::tempdir().unwrap();
    let server = fresh(directory.path(), Some(SETUP_CODE));
    let cookie = bootstrap(&server.router).await;

    let (status, _, setup) = request(
        &server.router,
        "GET",
        "/api/setup/library",
        None,
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(setup["library"], Value::Null);
    assert!(std::path::Path::new(setup["browseRoot"].as_str().unwrap()).is_absolute());

    let books = directory.path().join("Books");
    let inspect = |path: String| {
        request(
            &server.router,
            "POST",
            "/api/setup/library/inspect",
            Some(json!({"path": path})),
            Some(&cookie),
        )
    };
    let (_, _, inspection) = inspect(books.to_string_lossy().into_owned()).await;
    assert_eq!(inspection["status"], "missing");
    assert_eq!(inspection["name"], "Books");
    let (_, _, inspection) = inspect("Books".into()).await;
    assert_eq!(inspection["status"], "relative");
    let (_, _, inspection) = inspect(
        directory
            .path()
            .join("state/uploads/Books")
            .to_string_lossy()
            .into_owned(),
    )
    .await;
    assert_eq!(inspection["status"], "reserved");
    let (_, _, inspection) = inspect(directory.path().to_string_lossy().into_owned()).await;
    assert_eq!(inspection["status"], "reserved", "{inspection}");
    std::fs::write(directory.path().join("notes.txt"), "x").unwrap();
    std::fs::create_dir(directory.path().join(".hidden")).unwrap();
    let (_, _, inspection) = inspect(
        directory
            .path()
            .join("notes.txt")
            .to_string_lossy()
            .into_owned(),
    )
    .await;
    assert_eq!(inspection["status"], "notADirectory");

    let (status, _, info) = request(
        &server.router,
        "POST",
        "/api/setup/library",
        Some(json!({"mode": "create", "path": books.to_string_lossy(), "name": " Shelf "})),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert_eq!(info["name"], "Shelf");
    assert_eq!(info["available"], true);
    assert_eq!(info["readOnly"], false);
    assert_eq!(info["schemaVersion"], libcalibre::SCHEMA_VERSION);
    assert_eq!(info["upgradeAvailable"], false);
    assert!(books.join("metadata.db").is_file());
    assert!(server.source.is_open());

    let active = server.accounts.active_library().unwrap().unwrap();
    assert_eq!(active.id, info["id"]);
    let phil = server.accounts.user("phil").unwrap();
    assert!(server.accounts.can_access(&phil.id, &active.id).unwrap());

    let (status, _, library) =
        request(&server.router, "GET", "/api/library", None, Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(library["name"], "Shelf");
    assert_eq!(library["id"], active.id);
    let (_, _, session) = request(&server.router, "GET", "/api/session", None, Some(&cookie)).await;
    assert_eq!(session["libraryAccess"], true);
    let (_, _, setup) = request(&server.router, "GET", "/api/setup", None, None).await;
    assert_eq!(setup["libraryConfigured"], true);
    assert_eq!(setup["libraryAvailable"], true);

    let (status, _, error) = request(
        &server.router,
        "POST",
        "/api/setup/library",
        Some(json!({"mode": "create", "path": directory.path().join("Other").to_string_lossy()})),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");

    let (status, _, listing) = request(
        &server.router,
        "GET",
        &format!(
            "/api/setup/directories?path={}",
            urlencoding::encode(&directory.path().to_string_lossy())
        ),
        None,
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{listing}");
    let entries = listing["entries"].as_array().unwrap();
    let names: Vec<&str> = entries
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec!["Books", "state"],
        "dotfolders and files are hidden"
    );
    assert_eq!(entries[0]["isLibrary"], true);
    assert_eq!(entries[1]["isLibrary"], false);
    assert_eq!(
        listing["parent"].as_str().unwrap(),
        resolve(directory.path())
            .parent()
            .unwrap()
            .to_string_lossy()
    );
    let (status, _, _) = request(
        &server.router,
        "GET",
        "/api/setup/directories",
        None,
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn readers_never_reach_the_setup_routes() {
    let directory = tempfile::tempdir().unwrap();
    let server = fresh(directory.path(), Some(SETUP_CODE));
    bootstrap(&server.router).await;
    server
        .accounts
        .create_user("reader", "reader-password")
        .unwrap();
    let (status, headers, _) = request(
        &server.router,
        "POST",
        "/api/session",
        Some(json!({"username": "reader", "password": "reader-password"})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let reader = cookie(&headers);
    for (method, path, body) in [
        ("GET", "/api/setup/library", None),
        ("GET", "/api/setup/directories", None),
        (
            "POST",
            "/api/setup/library/inspect",
            Some(json!({"path": "/"})),
        ),
        (
            "POST",
            "/api/setup/library",
            Some(json!({"mode": "adopt", "path": "/"})),
        ),
        ("POST", "/api/setup/library/upgrade", None),
        ("POST", "/api/setup/library/reopen", None),
    ] {
        let (status, _, error) =
            request(&server.router, method, path, body.clone(), Some(&reader)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {error}");
        assert_eq!(error["message"], "Administrators only");
        let (status, _, _) = request(&server.router, method, path, body, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
    }
}

/// A Calibre 7.2 library (schema 26), the older-library fixture.
fn copy_fixture(target: &std::path::Path) {
    std::fs::create_dir_all(target).unwrap();
    let conn = rusqlite::Connection::open(target.join("metadata.db")).unwrap();
    conn.execute_batch(include_str!(
        "../../libcalibre/tests/fixtures/calibre_schema_26.sql"
    ))
    .unwrap();
    conn.execute(
        "INSERT INTO library_id (uuid) VALUES (?1)",
        [uuid::Uuid::new_v4().to_string()],
    )
    .unwrap();
}

#[tokio::test]
async fn adopting_an_older_library_offers_and_runs_calibres_upgrade() {
    let directory = tempfile::tempdir().unwrap();
    let server = fresh(directory.path(), Some(SETUP_CODE));
    let cookie = bootstrap(&server.router).await;
    let old = directory.path().join("Old Library");
    copy_fixture(&old);

    let (_, _, inspection) = request(
        &server.router,
        "POST",
        "/api/setup/library/inspect",
        Some(json!({"path": old.to_string_lossy()})),
        Some(&cookie),
    )
    .await;
    assert_eq!(inspection["status"], "library");
    assert_eq!(inspection["library"]["schemaVersion"], 26);
    assert_eq!(inspection["library"]["upgradeAvailable"], true);
    assert_eq!(inspection["library"]["supported"], true);
    assert_eq!(inspection["library"]["bookCount"], 0);
    assert_eq!(inspection["message"], Value::Null);

    let (status, _, info) = request(
        &server.router,
        "POST",
        "/api/setup/library",
        Some(json!({"mode": "adopt", "path": old.to_string_lossy()})),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert_eq!(info["name"], "Old Library");
    assert_eq!(info["schemaVersion"], 26);
    assert_eq!(info["upgradeAvailable"], true);

    let (status, _, upgrade) = request(
        &server.router,
        "POST",
        "/api/setup/library/upgrade",
        None,
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{upgrade}");
    assert_eq!(upgrade["from"], 26);
    assert_eq!(upgrade["to"], libcalibre::SCHEMA_VERSION);
    let backup = std::path::PathBuf::from(upgrade["backup"].as_str().unwrap());
    assert!(backup.is_file());
    assert_eq!(backup.parent().unwrap(), resolve(&old));
    let (_, _, setup) = request(
        &server.router,
        "GET",
        "/api/setup/library",
        None,
        Some(&cookie),
    )
    .await;
    assert_eq!(
        setup["library"]["schemaVersion"],
        libcalibre::SCHEMA_VERSION
    );
    assert_eq!(setup["library"]["upgradeAvailable"], false);
    let (status, _, _) = request(
        &server.router,
        "POST",
        "/api/setup/library/upgrade",
        None,
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn adopt_can_upgrade_first_and_refuses_unsupported_or_missing_libraries() {
    let directory = tempfile::tempdir().unwrap();
    let server = fresh(directory.path(), Some(SETUP_CODE));
    let cookie = bootstrap(&server.router).await;
    let old = directory.path().join("Old");
    copy_fixture(&old);
    let (status, _, error) = request(
        &server.router,
        "POST",
        "/api/setup/library",
        Some(json!({"mode": "adopt", "path": directory.path().join("Nowhere").to_string_lossy()})),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{error}");

    let ancient = directory.path().join("Ancient");
    copy_fixture(&ancient);
    rusqlite_set_version(&ancient.join("metadata.db"), 24);
    let (_, _, inspection) = request(
        &server.router,
        "POST",
        "/api/setup/library/inspect",
        Some(json!({"path": ancient.to_string_lossy()})),
        Some(&cookie),
    )
    .await;
    assert_eq!(inspection["library"]["supported"], false);
    assert!(inspection["message"]
        .as_str()
        .unwrap()
        .contains("open it in Calibre"));
    let (status, _, error) = request(
        &server.router,
        "POST",
        "/api/setup/library",
        Some(json!({"mode": "adopt", "path": ancient.to_string_lossy(), "upgrade": true})),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert!(error["message"].as_str().unwrap().contains("Calibre"));

    let (status, _, info) = request(
        &server.router,
        "POST",
        "/api/setup/library",
        Some(json!({"mode": "adopt", "path": old.to_string_lossy(), "upgrade": true})),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert_eq!(info["schemaVersion"], libcalibre::SCHEMA_VERSION);
    assert_eq!(info["upgradeAvailable"], false);
    assert!(
        libcalibre::schema_versions::backups(&old.join("metadata.db"))
            .unwrap()
            .len()
            == 1
    );
}

fn rusqlite_set_version(database: &std::path::Path, version: i32) {
    // The fixture is journal-mode; a plain connection changes only the header.
    let conn = rusqlite::Connection::open(database).unwrap();
    conn.execute_batch(&format!("PRAGMA user_version = {version}"))
        .unwrap();
}

#[tokio::test]
async fn the_chosen_library_survives_restart_and_a_missing_folder_is_reported() {
    let directory = tempfile::tempdir().unwrap();
    let books = directory.path().join("Books");
    {
        let server = fresh(directory.path(), Some(SETUP_CODE));
        let cookie = bootstrap(&server.router).await;
        let (status, _, _) = request(
            &server.router,
            "POST",
            "/api/setup/library",
            Some(json!({"mode": "create", "path": books.to_string_lossy()})),
            Some(&cookie),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    // A restart finds the library again without any configuration.
    let restarted = fresh(directory.path(), None);
    assert!(restarted.source.is_open());
    let info = restarted.served.info().unwrap();
    assert_eq!((info.available, info.name.as_str()), (true, "Books"));
    // Windows won't rename a folder whose database is open.
    drop(restarted);

    let moved = directory.path().join("Moved");
    std::fs::rename(&books, &moved).unwrap();
    let broken = fresh(directory.path(), None);
    assert!(!broken.source.is_open());
    let info = broken.served.info().unwrap();
    assert!(!info.available);
    assert!(
        info.problem
            .as_deref()
            .unwrap()
            .contains("not a Calibre library"),
        "{info:?}"
    );
    let (status, headers, _) = request(
        &broken.router,
        "POST",
        "/api/session",
        Some(json!({"username": "phil", "password": "a long password"})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cookie = cookie(&headers);
    let (_, _, setup) = request(&broken.router, "GET", "/api/setup", None, None).await;
    assert_eq!(setup["libraryConfigured"], true);
    assert_eq!(setup["libraryAvailable"], false);
    let (status, _, _) = request(&broken.router, "GET", "/api/library", None, Some(&cookie)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    let (_, _, setup) = request(
        &broken.router,
        "GET",
        "/api/setup/library",
        None,
        Some(&cookie),
    )
    .await;
    assert_eq!(setup["library"]["available"], false);
    assert!(setup["library"]["problem"].is_string());

    let other = directory.path().join("Other");
    drop(libcalibre::Library::create_library_at(other.to_str().unwrap()).unwrap());
    let (status, _, error) = request(
        &broken.router,
        "POST",
        "/api/setup/library",
        Some(json!({"mode": "adopt", "path": other.to_string_lossy()})),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert!(error["message"]
        .as_str()
        .unwrap()
        .contains("different library"));

    let (status, _, info) = request(
        &broken.router,
        "POST",
        "/api/setup/library",
        Some(json!({"mode": "adopt", "path": moved.to_string_lossy()})),
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert_eq!(info["available"], true);
    assert_eq!(
        info["path"].as_str().unwrap(),
        resolve(&moved).to_string_lossy()
    );
    let (status, _, _) = request(&broken.router, "GET", "/api/library", None, Some(&cookie)).await;
    assert_eq!(status, StatusCode::OK);

    broken.source.close();
    std::fs::rename(&moved, &books).unwrap();
    let (status, _, info) = request(
        &broken.router,
        "POST",
        "/api/setup/library/reopen",
        None,
        Some(&cookie),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{info}");
    assert_eq!(
        info["available"], false,
        "the registry still points at Moved"
    );
    std::fs::rename(&books, &moved).unwrap();
    let (_, _, info) = request(
        &broken.router,
        "POST",
        "/api/setup/library/reopen",
        None,
        Some(&cookie),
    )
    .await;
    assert_eq!(info["available"], true);
}
