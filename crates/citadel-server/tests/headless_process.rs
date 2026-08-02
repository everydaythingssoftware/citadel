#![cfg(unix)]

use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    net::TcpListener,
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use libcalibre::{BookAdd, Library};
use nix::{
    sys::signal::{kill, Signal},
    unistd::Pid,
};

#[test]
fn real_process_serves_authenticated_catalog_and_acquisition_then_stops() {
    let directory = tempfile::tempdir().unwrap();
    let library_path = directory.path().join("library");
    let state_path = directory.path().join("state");
    std::fs::create_dir_all(&library_path).unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../libcalibre/tests/fixtures/empty_library/metadata.db");
    std::fs::copy(fixture, library_path.join("metadata.db")).unwrap();

    let database = libcalibre::util::get_db_path(library_path.to_str().unwrap()).unwrap();
    let mut library = Library::new(database).unwrap();
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

    let reservation = TcpListener::bind("0.0.0.0:0").unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let config_path = directory.path().join("server.toml");
    std::fs::write(
        &config_path,
        format!(
            r#"libraryPath = "{}"
stateDirectory = "{}"

[sharing]
port = {port}
authenticationEnabled = true

[sharing.target]
type = "addresses"
addresses = ["127.0.0.1"]

[credentials]
username = "reader"
passwordEnvironment = "CITADEL_TEST_OPDS_PASSWORD"
"#,
            library_path.display(),
            state_path.display()
        ),
    )
    .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_citadel-server"))
        .args(["--config", config_path.to_str().unwrap()])
        .env("CITADEL_TEST_OPDS_PASSWORD", "secret")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (lines_tx, lines_rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = lines_tx.send(line);
        }
    });

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut observed = Vec::new();
    let catalog_url = loop {
        assert!(
            Instant::now() < deadline,
            "server did not start: {observed:?}"
        );
        if let Ok(line) = lines_rx.recv_timeout(Duration::from_millis(250)) {
            if let Some(urls) = line
                .split_whitespace()
                .find_map(|field| field.strip_prefix("urls="))
            {
                if line.contains("state=Running") {
                    break urls.split(',').next().unwrap().to_string();
                }
            }
            observed.push(line);
        }
        if let Some(status) = child.try_wait().unwrap() {
            panic!("server exited before listening with {status}: {observed:?}");
        }
    };

    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    assert_eq!(client.get(&catalog_url).send().unwrap().status(), 401);
    let feed = client
        .get(&catalog_url)
        .basic_auth("reader", Some("secret"))
        .send()
        .unwrap();
    assert!(feed.status().is_success());
    assert!(feed.text().unwrap().contains("Headless Citadel"));

    let origin = catalog_url.strip_suffix("/opds").unwrap();
    let acquisition = client
        .get(format!(
            "{origin}/opds/books/{}/files/EPUB/book.epub",
            book.id.as_i32()
        ))
        .header(
            "Authorization",
            format!("Basic {}", STANDARD.encode("reader:secret")),
        )
        .send()
        .unwrap();
    assert!(acquisition.status().is_success());
    assert_eq!(
        acquisition.bytes().unwrap().as_ref(),
        b"headless-acquisition"
    );

    kill(Pid::from_raw(child.id() as i32), Signal::SIGTERM).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let exit = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            panic!("server did not stop after SIGTERM");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(exit.success());

    observed.extend(lines_rx.try_iter());
    assert!(observed.iter().any(|line| line.contains("state=Stopped")));
    let credential_file =
        std::fs::read_to_string(state_path.join("opds-credentials.json")).unwrap();
    assert!(credential_file.contains("$argon2id$"));
    assert!(!credential_file.contains("secret"));
}
