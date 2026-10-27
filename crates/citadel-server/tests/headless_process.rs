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
    let api_reservation = TcpListener::bind("127.0.0.1:0").unwrap();
    let api_port = api_reservation.local_addr().unwrap().port();
    drop(api_reservation);
    let config_path = directory.path().join("server.toml");
    std::fs::write(
        &config_path,
        format!(
            r#"libraryPath = "{}"

[api]
listen = "127.0.0.1:{api_port}"
publicUrl = "http://127.0.0.1:{api_port}"

[sharing]
port = {port}

[sharing.target.addresses]
addresses = ["127.0.0.1"]

"#,
            library_path.display()
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
    let app_password = |output: &str| {
        output
            .lines()
            .find_map(|line| line.strip_prefix("OPDS app password: "))
            .unwrap()
            .to_string()
    };

    let without_users = server(&[]).output().unwrap();
    assert!(!without_users.status.success());
    assert!(String::from_utf8_lossy(&without_users.stderr).contains("users add <name>"));
    let state_directory = state_path.join("citadel");
    assert!(state_directory.join("citadel.db").is_file());

    let reader_app = app_password(&admin(
        &["users", "add", "reader", "--password-stdin"],
        "reader-password\n",
    ));
    let reviewer = admin(&["users", "add", "reviewer"], "");
    let reviewer_app = app_password(&reviewer);
    assert!(reviewer.contains("Sign-in password: "));

    let mut child = ServerProcess(
        server(&[])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
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

    // OPDS reports Running before the optional API listener starts.
    while !observed.iter().any(|line| line.contains("api=http://")) {
        assert!(Instant::now() < deadline, "API did not start: {observed:?}");
        observed.push(lines_rx.recv_timeout(Duration::from_secs(5)).unwrap());
    }
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
    let rotated = app_password(&admin(&["users", "app-password", "reader", "--rotate"], ""));
    admin(&["revoke", "reviewer"], "");
    std::thread::sleep(Duration::from_secs(3));
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
    let released =
        TcpListener::bind(("127.0.0.1", api_port)).expect("API listener released on shutdown");
    drop(released);

    observed.extend(lines_rx.try_iter());
    assert!(observed.iter().any(|line| line.contains("state=Stopped")));
    assert!(state_directory.join("citadel.db").is_file());
}
