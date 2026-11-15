#![cfg(unix)]

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read},
    net::TcpListener,
    process::{Command, Stdio},
    sync::mpsc::{self, RecvTimeoutError},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use libcalibre::{BookAdd, Library};
use nix::{
    sys::signal::{kill, Signal},
    unistd::Pid,
};

/// Deadlines are generous so a loaded machine (the whole workspace's tests at
/// once) doesn't fail them; every wait returns as soon as its condition holds.
const START_UP: Duration = Duration::from_secs(60);
const SETTLE: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Every line a child prints on the given streams, in the order they arrive.
/// Lines from different streams can arrive in either order, so wait for each
/// line needed rather than for one and then expect the others.
struct Output {
    received: mpsc::Receiver<String>,
    lines: Vec<String>,
}

impl Output {
    fn of(streams: Vec<Box<dyn Read + Send>>) -> Self {
        let (sender, received) = mpsc::channel();
        for stream in streams {
            let sender = sender.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    let _ = sender.send(line);
                }
            });
        }
        Self {
            received,
            lines: Vec::new(),
        }
    }

    fn wait_for(&mut self, within: Duration, what: &str, done: impl Fn(&[String]) -> bool) {
        let deadline = Instant::now() + within;
        while !done(&self.lines) {
            match self
                .received
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(line) => self.lines.push(line),
                Err(RecvTimeoutError::Timeout) => {
                    panic!("no {what} within {within:?}: {:#?}", self.lines)
                }
                Err(RecvTimeoutError::Disconnected) => {
                    panic!(
                        "the server closed its output before {what}: {:#?}",
                        self.lines
                    )
                }
            }
        }
    }

    fn wait_for_line(&mut self, within: Duration, what: &str, matches: impl Fn(&str) -> bool) {
        self.wait_for(within, what, |lines| lines.iter().any(|line| matches(line)));
    }

    fn log(&self) -> String {
        self.lines.join("\n")
    }
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .unwrap()
}

/// Sends SIGTERM and waits for the exit. A server that hangs is killed after
/// `SETTLE`, so the test fails instead of hanging too.
fn stop(child: &mut ServerProcess) -> std::process::ExitStatus {
    let pid = Pid::from_raw(child.id() as i32);
    kill(pid, Signal::SIGTERM).unwrap();
    let (exited, exit_seen) = mpsc::channel::<()>();
    let watchdog = std::thread::spawn(move || {
        let hung = exit_seen.recv_timeout(SETTLE) == Err(RecvTimeoutError::Timeout);
        if hung {
            let _ = kill(pid, Signal::SIGKILL);
        }
        hung
    });
    let status = child.wait().unwrap();
    drop(exited);
    assert!(
        !watchdog.join().unwrap(),
        "no exit within {SETTLE:?} of SIGTERM"
    );
    status
}

struct ServerProcess(std::process::Child);
impl std::ops::Deref for ServerProcess {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl std::ops::DerefMut for ServerProcess {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}
impl Drop for ServerProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn real_process_serves_authenticated_catalog_and_acquisition_then_stops() {
    let directory = tempfile::tempdir().unwrap();
    let library_path = directory.path().join("library");
    let state_path = directory.path().join("state");
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
            description: None,
            identifiers: HashMap::new(),
            language: Some("eng".to_string()),
            file_paths: vec![source],
        })
        .unwrap();
    drop(library);

    let reservation = TcpListener::bind("0.0.0.0:0").unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let api_reservation = TcpListener::bind("127.0.0.1:0").unwrap();
    let api_port = api_reservation.local_addr().unwrap().port();
    drop(api_reservation);
    let config_path = directory.path().join("server.toml");
    std::fs::write(
        &config_path,
        format!(
            r#"[api]
listen = "127.0.0.1:{api_port}"
publicUrls = ["http://127.0.0.1:{api_port}"]

[sharing]
port = {port}

[sharing.target.addresses]
addresses = ["127.0.0.1"]

"#
        ),
    )
    .unwrap();

    let server = |args: &[&str]| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_citadel-server"));
        command
            .args(["--config", config_path.to_str().unwrap()])
            .args(args)
            .env("XDG_STATE_HOME", &state_path);
        command
    };
    let admin = |args: &[&str], stdin: &str| {
        let mut child = server(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(&mut child.stdin.take().unwrap(), stdin.as_bytes()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    };
    let device_key = |output: &str| {
        output
            .lines()
            .find_map(|line| line.strip_prefix("OPDS device key: "))
            .unwrap()
            .to_string()
    };

    // The library is registered in citadel.db, not the config file.
    let registered = admin(&["libraries", "add", library_path.to_str().unwrap()], "");
    assert!(registered.starts_with("Serving library"), "{registered}");
    let state_directory = state_path.join("citadel");
    assert!(state_directory.join("citadel.db").is_file());

    admin(
        &["users", "add", "reader", "--password-stdin"],
        "reader-password\n",
    );
    let reader_app = device_key(&admin(&["users", "keys", "reader", "add", "Kobo"], ""));
    let reviewer = admin(&["users", "add", "reviewer"], "");
    assert!(reviewer.contains("Sign-in password: "));
    let reviewer_app = device_key(&admin(&["users", "keys", "reviewer", "add", "Kobo"], ""));

    let mut child = ServerProcess(
        server(&[])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let mut output = Output::of(vec![Box::new(child.stdout.take().unwrap())]);
    let running = |line: &str| line.contains("state=Running") && line.contains("urls=");
    output.wait_for_line(START_UP, "running OPDS status", running);
    let catalog_url = output
        .lines
        .iter()
        .find(|line| running(line))
        .and_then(|line| {
            line.split_whitespace()
                .find_map(|field| field.strip_prefix("urls="))
        })
        .and_then(|urls| urls.split(',').next())
        .unwrap()
        .to_string();

    let client = client();
    assert_eq!(client.get(&catalog_url).send().unwrap().status(), 401);
    let feed = client
        .get(&catalog_url)
        .basic_auth("reader", Some(&reader_app))
        .send()
        .unwrap();
    assert!(feed.status().is_success());
    assert!(feed.text().unwrap().contains("All Books"));
    let all = client
        .get(format!("{catalog_url}/all"))
        .basic_auth("reader", Some(&reader_app))
        .send()
        .unwrap();
    assert!(all.text().unwrap().contains("Headless Citadel"));

    let second = client
        .get(&catalog_url)
        .basic_auth("reviewer", Some(&reviewer_app))
        .send()
        .unwrap();
    assert_eq!(second.status(), 200);
    assert_eq!(
        client
            .get(&catalog_url)
            .basic_auth("reader", Some("wrong"))
            .send()
            .unwrap()
            .status(),
        401
    );

    // The API listens from the start; OPDS followed once the library and a
    // reader existed. No administrator was made, so the setup code was printed.
    output.wait_for_line(START_UP, "API address", |line| line.contains("api=http://"));
    output.wait_for_line(START_UP, "setup code", |line| {
        line.contains("\"setup_code\":\"")
    });
    let api_origin = format!("http://127.0.0.1:{api_port}");
    assert_eq!(
        client
            .get(format!("{api_origin}/api/openapi.json"))
            .send()
            .unwrap()
            .status(),
        401
    );
    let signed_in = client
        .post(format!("{api_origin}/api/session"))
        .header("content-type", "application/json")
        .header("origin", &api_origin)
        .body(r#"{"username":"reader","password":"reader-password"}"#)
        .send()
        .unwrap();
    assert_eq!(signed_in.status(), 200);
    let cookie = signed_in.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let api_book = client
        .get(format!("{api_origin}/api/books/{}", book.id.as_i32()))
        .header("cookie", &cookie)
        .send()
        .unwrap();
    assert_eq!(api_book.status(), 200);
    let api_book: serde_json::Value = serde_json::from_str(&api_book.text().unwrap()).unwrap();
    assert_eq!(api_book["title"], "Headless Citadel");

    let origin = catalog_url.strip_suffix("/opds").unwrap();
    let asset_url = format!(
        "{origin}/opds/books/{}/files/EPUB/book.epub",
        book.id.as_i32()
    );
    let head = client
        .head(&asset_url)
        .basic_auth("reader", Some(&reader_app))
        .send()
        .unwrap();
    assert!(head.status().is_success());
    assert_eq!(
        head.headers()["content-length"],
        b"headless-acquisition".len().to_string()
    );
    let range = client
        .get(&asset_url)
        .basic_auth("reader", Some(&reader_app))
        .header("Range", "bytes=2-5")
        .send()
        .unwrap();
    assert_eq!(range.status(), 206);
    assert_eq!(range.bytes().unwrap().as_ref(), b"adle");

    let acquisition = client
        .get(format!(
            "{origin}/opds/books/{}/files/EPUB/book.epub",
            book.id.as_i32()
        ))
        .header(
            "Authorization",
            format!("Basic {}", STANDARD.encode(format!("reader:{reader_app}"))),
        )
        .send()
        .unwrap();
    assert!(acquisition.status().is_success());
    assert_eq!(
        acquisition.bytes().unwrap().as_ref(),
        b"headless-acquisition"
    );

    // Admin changes reach the running server without a restart.
    let rotated = device_key(&admin(&["users", "keys", "reader", "rotate", "Kobo"], ""));
    admin(&["revoke", "reviewer"], "");
    let opds_status = |username: &str, password: &str| {
        client
            .get(&catalog_url)
            .basic_auth(username, Some(password))
            .send()
            .unwrap()
            .status()
    };
    assert_eq!(opds_status("reader", &rotated), 200);
    assert_eq!(opds_status("reader", &reader_app), 401);
    assert_eq!(opds_status("reviewer", &reviewer_app), 401);
    // Signing in records when the key was last used.
    let keys = admin(&["users", "keys", "reader"], "");
    assert!(
        keys.contains("Kobo") && keys.contains("last used"),
        "{keys}"
    );

    assert!(stop(&mut child).success());
    let released =
        TcpListener::bind(("127.0.0.1", api_port)).expect("API listener released on shutdown");
    drop(released);

    output.wait_for_line(SETTLE, "stopped OPDS status", |line| {
        line.contains("state=Stopped")
    });
    assert!(state_directory.join("citadel.db").is_file());
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[test]
fn the_server_runs_from_environment_variables_alone() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let api_port = free_port();
    let opds_port = free_port();
    let with_settings = |command: &mut Command| {
        command
            .env_remove("CITADEL_CONFIG")
            .env("CITADEL_LISTEN", format!("127.0.0.1:{api_port}"))
            .env("CITADEL_OPDS_PORT", opds_port.to_string())
            .env("CITADEL_STATE_DIRECTORY", &state);
    };
    let health = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_citadel-server"));
        with_settings(&mut command);
        command.arg("health").output().unwrap()
    };
    assert!(
        !health().status.success(),
        "nothing is listening yet, so the check fails"
    );

    let mut command = Command::new(env!("CARGO_BIN_EXE_citadel-server"));
    with_settings(&mut command);
    let mut child = ServerProcess(
        command
            .env("CITADEL_PUBLICURL", "http://typo.example")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut output = Output::of(vec![
        Box::new(child.stdout.take().unwrap()),
        Box::new(child.stderr.take().unwrap()),
    ]);
    output.wait_for_line(START_UP, "API address", |line| {
        line.contains("citadel_server api=")
    });
    output.wait_for_line(START_UP, "misspelled setting warning", |line| {
        line.contains("configure nothing")
    });
    let log = output.log();
    assert!(log.contains("\"setup_code\":\""), "{log}");
    assert!(
        log.contains("public_urls=any"),
        "no address is known until the first administrator's: {log}"
    );
    assert!(
        log.contains(&format!("Open http://127.0.0.1:{api_port} and enter")),
        "the setup code says where to go: {log}"
    );
    assert!(
        log.contains("CITADEL_PUBLICURL configure nothing"),
        "a misspelled setting is pointed out: {log}"
    );
    assert!(state.join("citadel.db").exists());

    let output = health();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn a_database_from_a_newer_citadel_keeps_the_server_answering_with_the_reason() {
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
    let api_port = free_port();
    let with_settings = |command: &mut Command| {
        command
            .env_remove("CITADEL_CONFIG")
            .env("CITADEL_LISTEN", format!("127.0.0.1:{api_port}"))
            .env("CITADEL_OPDS_PORT", free_port().to_string())
            .env("CITADEL_STATE_DIRECTORY", &state);
    };
    let mut command = Command::new(env!("CARGO_BIN_EXE_citadel-server"));
    with_settings(&mut command);
    let mut child = ServerProcess(
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut output = Output::of(vec![
        Box::new(child.stdout.take().unwrap()),
        Box::new(child.stderr.take().unwrap()),
    ]);
    // The address is printed on stdout once listening, the reason on stderr.
    output.wait_for_line(START_UP, "failing health", |line| {
        line.contains("health=failing")
    });
    output.wait_for_line(START_UP, "reason", |line| {
        line.contains("newer version of Citadel")
    });

    let mut health = Command::new(env!("CARGO_BIN_EXE_citadel-server"));
    with_settings(&mut health);
    let output = health.arg("health").output().unwrap();
    assert!(!output.status.success());
    let said = String::from_utf8_lossy(&output.stderr);
    assert!(said.contains("health=failing database=failing"), "{said}");

    let client = client();
    let refused = client
        .get(format!("http://127.0.0.1:{api_port}/api/setup"))
        .send()
        .unwrap();
    assert_eq!(refused.status().as_u16(), 503);
    let body: serde_json::Value = refused.json().unwrap();
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("Citadel can't start"),
        "{body}"
    );
    let health: serde_json::Value = client
        .get(format!("http://127.0.0.1:{api_port}/api/health"))
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert!(
        health["checks"][0]["detail"]
            .as_str()
            .unwrap()
            .contains("newer version of Citadel"),
        "{health}"
    );

    assert!(
        !stop(&mut child).success(),
        "stopping still reports the failure"
    );
}
