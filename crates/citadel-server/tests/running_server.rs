//! The whole server, run in-process through its `Shell`: the JSON API's
//! router and what OPDS serves are called directly, the log is read as it is
//! written, and the server stops when the test says. Nothing binds a port;
//! `docker/smoke-test.sh` checks the real binary in its image.
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    body::Body,
    http::{header, HeaderMap, Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use citadel_core::http::{HttpClient, HttpError, HttpErrorKind, HttpFuture, HttpRequest};
use citadel_host::{InProcessHost, RouterHttp};
use citadel_server::{
    shell::{ApiListener, RunningApi, ServerLog, Shell, ShellFuture},
    ServerConfig,
};
use libcalibre::{BookAdd, Library};
use tokio::sync::{oneshot, Notify};
use tower::ServiceExt;

/// Only guards against a hang; every wait ends as soon as its event happens.
const HANG: Duration = Duration::from_secs(30);

#[derive(Default)]
struct TestLog {
    lines: Mutex<Vec<String>>,
    written: Notify,
}

impl ServerLog for TestLog {
    fn info(&self, line: String) {
        self.write(line);
    }

    fn warn(&self, line: String) {
        self.write(line);
    }
}

impl TestLog {
    fn write(&self, line: String) {
        self.lines
            .lock()
            .unwrap()
            .extend(line.lines().map(String::from));
        self.written.notify_waiters();
    }

    fn text(&self) -> String {
        self.lines.lock().unwrap().join("\n")
    }

    /// The first line, written so far or later, that `matches`.
    async fn line(&self, matches: impl Fn(&str) -> bool) -> String {
        tokio::time::timeout(HANG, async {
            loop {
                let written = self.written.notified();
                tokio::pin!(written);
                written.as_mut().enable();
                if let Some(line) = self.lines.lock().unwrap().iter().find(|line| matches(line)) {
                    return line.clone();
                }
                written.await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("never logged; the log was:\n{}", self.text()))
    }
}

/// Hands the JSON API's router to the test instead of serving it.
struct CapturedApi(Mutex<Option<oneshot::Sender<Router>>>);

impl ApiListener for CapturedApi {
    fn start(
        &self,
        _listen: std::net::SocketAddr,
        app: Router,
    ) -> ShellFuture<Result<RunningApi, String>> {
        if let Some(captured) = self.0.lock().unwrap().take() {
            let _ = captured.send(app);
        }
        Box::pin(async {
            let (shutdown, stopped) = oneshot::channel();
            let task = tokio::spawn(async move {
                let _ = stopped.await;
                Ok(())
            });
            Ok(RunningApi::new(shutdown, task))
        })
    }
}

/// Nothing answers.
struct Unreachable;

impl HttpClient for Unreachable {
    fn send(&self, _: HttpRequest) -> HttpFuture<'static, citadel_core::http::HttpResponse> {
        Box::pin(async {
            Err(HttpError::new(
                HttpErrorKind::Connection,
                "connection refused",
            ))
        })
    }
}

struct Running {
    api: Router,
    opds: InProcessHost,
    log: Arc<TestLog>,
    stop: oneshot::Sender<()>,
    finished: tokio::task::JoinHandle<Result<(), String>>,
}

impl Running {
    async fn start(config: ServerConfig) -> Self {
        let opds = InProcessHost::default();
        let log = Arc::new(TestLog::default());
        let (captured, api) = oneshot::channel();
        let (stop, stopped) = oneshot::channel::<()>();
        let shell = Shell {
            opds_host: Arc::new(opds.clone()),
            http: Arc::new(Unreachable),
            api: Arc::new(CapturedApi(Mutex::new(Some(captured)))),
            log: log.clone(),
            shutdown: Box::pin(async move {
                let _ = stopped.await;
                Ok(())
            }),
            check_now: Arc::new(Notify::new()),
        };
        let finished = tokio::spawn(citadel_server::run_in(config, shell));
        let api = tokio::time::timeout(HANG, api)
            .await
            .expect("the API never started")
            .unwrap_or_else(|_| panic!("the server stopped first:\n{}", log.text()));
        Self {
            api,
            opds,
            log,
            stop,
            finished,
        }
    }

    async fn stop(self) -> (Result<(), String>, Arc<TestLog>) {
        let _ = self.stop.send(());
        let result = tokio::time::timeout(HANG, self.finished)
            .await
            .expect("the server didn't stop")
            .unwrap();
        (result, self.log)
    }
}

async fn send(router: &Router, request: Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
    let response = router.clone().oneshot(request).await.unwrap();
    let (parts, body) = response.into_parts();
    let body = axum::body::to_bytes(body, usize::MAX).await.unwrap();
    (parts.status, parts.headers, body.to_vec())
}

fn get(path: &str) -> axum::http::request::Builder {
    Request::get(path)
}

fn basic(username: &str, key: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!("{username}:{key}")))
}

fn admin(config: &ServerConfig, args: &[&str], stdin: &str) -> String {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    citadel_server::admin::run(config, &args, stdin.as_bytes()).unwrap()
}

fn device_key(output: &str) -> String {
    output
        .lines()
        .find_map(|line| line.strip_prefix("OPDS device key: "))
        .unwrap()
        .to_string()
}

fn config_file(directory: &Path, text: &str) -> ServerConfig {
    let path = directory.join("server.toml");
    std::fs::write(&path, text).unwrap();
    citadel_server::load_config(&path).unwrap()
}

#[tokio::test]
async fn serves_the_catalog_and_books_to_signed_in_readers_and_follows_admin_changes() {
    let directory = tempfile::tempdir().unwrap();
    let library_path = directory.path().join("library");
    let mut library = Library::create_library_at(library_path.to_str().unwrap()).unwrap();
    let source = directory.path().join("source.epub");
    std::fs::write(&source, b"headless-acquisition").unwrap();
    let book = library
        .add_book(BookAdd {
            title: "Headless Citadel".to_string(),
            author_names: vec!["Citadel Test".to_string()],
            tags: None,
            series: None,
            series_index: None,
            publisher: None,
            publication_date: None,
            rating: None,
            comments: None,
            identifiers: HashMap::new(),
            language: Some("eng".to_string()),
            file_paths: vec![source],
        })
        .unwrap();
    drop(library);
    let state = directory.path().join("state");
    let config = config_file(
        directory.path(),
        &format!(
            r#"stateDirectory = '{}'

[api]
listen = "127.0.0.1:8081"
publicUrls = ["http://127.0.0.1:8081"]

[sharing]
port = 8080

[sharing.target.addresses]
addresses = ["127.0.0.1"]
"#,
            state.display()
        ),
    );

    // The library is registered in citadel.db, not the config file.
    let registered = admin(
        &config,
        &["libraries", "add", library_path.to_str().unwrap()],
        "",
    );
    assert!(registered.starts_with("Serving library"), "{registered}");
    admin(
        &config,
        &["users", "add", "reader", "--password-stdin"],
        "reader-password\n",
    );
    let reader_app = device_key(&admin(
        &config,
        &["users", "keys", "reader", "add", "Kobo"],
        "",
    ));
    let reviewer = admin(&config, &["users", "add", "reviewer"], "");
    assert!(reviewer.contains("Sign-in password: "));
    let reviewer_app = device_key(&admin(
        &config,
        &["users", "keys", "reviewer", "add", "Kobo"],
        "",
    ));

    let server = Running::start(config).await;
    // OPDS started before the API, once the library and a reader existed.
    let opds = server
        .opds
        .router("127.0.0.1:8080".parse().unwrap())
        .expect("OPDS serves at the configured address");
    let catalog = |key: Option<(&str, &str)>, path: &str| {
        let mut request = get(path);
        if let Some((username, key)) = key {
            request = request.header(header::AUTHORIZATION, basic(username, key));
        }
        send(&opds, request.body(Body::empty()).unwrap())
    };
    assert_eq!(catalog(None, "/opds").await.0, StatusCode::UNAUTHORIZED);
    let (status, _, feed) = catalog(Some(("reader", &reader_app)), "/opds").await;
    assert_eq!(status, StatusCode::OK);
    assert!(String::from_utf8_lossy(&feed).contains("All Books"));
    let (_, _, all) = catalog(Some(("reader", &reader_app)), "/opds/all").await;
    assert!(String::from_utf8_lossy(&all).contains("Headless Citadel"));
    assert_eq!(
        catalog(Some(("reviewer", &reviewer_app)), "/opds").await.0,
        StatusCode::OK
    );
    assert_eq!(
        catalog(Some(("reader", "wrong")), "/opds").await.0,
        StatusCode::UNAUTHORIZED
    );

    // No administrator was made, so the setup code was printed.
    server
        .log
        .line(|line| line.contains("\"setup_code\":\""))
        .await;
    let api_origin = "http://127.0.0.1:8081";
    let api = |request: axum::http::request::Builder, body: &str| {
        send(
            &server.api,
            request
                .header(header::HOST, "127.0.0.1:8081")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
    };
    assert_eq!(
        api(get("/api/openapi.json"), "").await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, headers, _) = api(
        Request::post("/api/session")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ORIGIN, api_origin),
        r#"{"username":"reader","password":"reader-password"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let cookie = headers[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let (status, _, api_book) = api(
        get(&format!("/api/books/{}", book.id.as_i32())).header(header::COOKIE, &cookie),
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let api_book: serde_json::Value = serde_json::from_slice(&api_book).unwrap();
    assert_eq!(api_book["title"], "Headless Citadel");

    let asset = format!("/opds/books/{}/files/EPUB/book.epub", book.id.as_i32());
    let reader = basic("reader", &reader_app);
    let (status, headers, _) = send(
        &opds,
        Request::head(&asset)
            .header(header::AUTHORIZATION, &reader)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert!(status.is_success());
    assert_eq!(
        headers[header::CONTENT_LENGTH],
        b"headless-acquisition".len().to_string()
    );
    let (status, _, range) = send(
        &opds,
        get(&asset)
            .header(header::AUTHORIZATION, &reader)
            .header(header::RANGE, "bytes=2-5")
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(range, b"adle");
    let (status, _, acquired) = send(
        &opds,
        get(&asset)
            .header(header::AUTHORIZATION, &reader)
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert!(status.is_success());
    assert_eq!(acquired, b"headless-acquisition");

    // The admin CLI changes citadel.db from its own connection; the next
    // sign-in already follows it.
    let config = citadel_server::load_config(&directory.path().join("server.toml")).unwrap();
    let rotated = device_key(&admin(
        &config,
        &["users", "keys", "reader", "rotate", "Kobo"],
        "",
    ));
    admin(&config, &["revoke", "reviewer"], "");
    assert_eq!(
        catalog(Some(("reader", &rotated)), "/opds").await.0,
        StatusCode::OK
    );
    assert_eq!(
        catalog(Some(("reader", &reader_app)), "/opds").await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        catalog(Some(("reviewer", &reviewer_app)), "/opds").await.0,
        StatusCode::UNAUTHORIZED
    );
    // Signing in records when the key was last used.
    let keys = admin(&config, &["users", "keys", "reader"], "");
    assert!(
        keys.contains("Kobo") && keys.contains("last used"),
        "{keys}"
    );

    let (stopped, log) = server.stop().await;
    assert_eq!(stopped, Ok(()));
    assert!(log.text().contains("state=Stopped"), "{}", log.text());
    assert!(state.join("citadel.db").is_file());
}

#[tokio::test]
async fn the_server_runs_from_environment_variables_alone() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let settings = HashMap::from([
        ("CITADEL_LISTEN", "127.0.0.1:8081".to_string()),
        ("CITADEL_OPDS_PORT", "8080".to_string()),
        ("CITADEL_STATE_DIRECTORY", state.display().to_string()),
    ]);
    let config =
        citadel_server::environment::config_from(|name| settings.get(name).cloned()).unwrap();
    let nothing_listening = citadel_server::health_with(&config, &Unreachable).await;
    assert!(
        nothing_listening.unwrap_err().contains("no answer"),
        "the check fails while nothing answers"
    );

    let config =
        citadel_server::environment::config_from(|name| settings.get(name).cloned()).unwrap();
    let server = Running::start(config).await;
    let log = &server.log;
    log.line(|line| line.contains("citadel_server api=")).await;
    let text = log.text();
    assert!(text.contains("\"setup_code\":\""), "{text}");
    assert!(
        text.contains("public_urls=any"),
        "no address is known until the first administrator's: {text}"
    );
    assert!(
        text.contains("Open http://127.0.0.1:8081 and enter"),
        "the setup code says where to go: {text}"
    );
    assert!(state.join("citadel.db").exists());

    let config =
        citadel_server::environment::config_from(|name| settings.get(name).cloned()).unwrap();
    // Without a library it is degraded, but healthy enough to pass.
    citadel_server::health_with(&config, &RouterHttp::new(server.api.clone()))
        .await
        .unwrap();
    assert_eq!(server.stop().await.0, Ok(()));
}

#[tokio::test]
async fn a_database_from_a_newer_citadel_keeps_the_server_answering_with_the_reason() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    std::fs::create_dir_all(&state).unwrap();
    drop(citadel_core::store::CitadelStore::open(&state.join("citadel.db")).unwrap());
    rusqlite::Connection::open(state.join("citadel.db"))
        .unwrap()
        .execute(
            "INSERT INTO __diesel_schema_migrations (version) VALUES ('29991231000000')",
            [],
        )
        .unwrap();
    let settings = HashMap::from([
        ("CITADEL_LISTEN", "127.0.0.1:8081".to_string()),
        ("CITADEL_OPDS_PORT", "8080".to_string()),
        ("CITADEL_STATE_DIRECTORY", state.display().to_string()),
    ]);
    let config = || citadel_server::environment::config_from(|name| settings.get(name).cloned());
    let server = Running::start(config().unwrap()).await;
    server
        .log
        .line(|line| line.contains("newer version of Citadel"))
        .await;

    let said =
        citadel_server::health_with(&config().unwrap(), &RouterHttp::new(server.api.clone()))
            .await
            .unwrap_err();
    assert!(said.contains("health=failing database=failing"), "{said}");
    let (status, _, body) = send(&server.api, get("/api/setup").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("Citadel can't start"),
        "{body}"
    );
    let (_, _, health) = send(&server.api, get("/api/health").body(Body::empty()).unwrap()).await;
    let health: serde_json::Value = serde_json::from_slice(&health).unwrap();
    assert!(
        health["checks"][0]["detail"]
            .as_str()
            .unwrap()
            .contains("newer version of Citadel"),
        "{health}"
    );

    let (stopped, _) = server.stop().await;
    assert!(stopped.is_err(), "stopping still reports the failure");
}
