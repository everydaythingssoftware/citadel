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

    // The API listens from the start; OPDS followed once the library and a
    // reader existed. No administrator was made, so the setup code was printed.
    while !observed.iter().any(|line| line.contains("api=http://")) {
        assert!(Instant::now() < deadline, "API did not start: {observed:?}");
        observed.push(lines_rx.recv_timeout(Duration::from_secs(5)).unwrap());
    }
    assert!(
        observed
            .iter()
            .any(|line| line.contains("\"setup_code\":\"")),
        "{observed:?}"
    );
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
    // Signing in records when the key was last used.
    std::thread::sleep(Duration::from_millis(500));
    let keys = admin(&["users", "keys", "reader"], "");
    assert!(
        keys.contains("Kobo") && keys.contains("last used"),
        "{keys}"
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
    let released =
        TcpListener::bind(("127.0.0.1", api_port)).expect("API listener released on shutdown");
    drop(released);

    observed.extend(lines_rx.try_iter());
    assert!(observed.iter().any(|line| line.contains("state=Stopped")));
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
    let (lines, received) = mpsc::channel();
    for stream in [
        Box::new(child.stdout.take().unwrap()) as Box<dyn std::io::Read + Send>,
        Box::new(child.stderr.take().unwrap()),
    ] {
        let lines = lines.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let _ = lines.send(line);
            }
        });
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut seen = Vec::new();
    while !seen
        .iter()
        .any(|line: &String| line.contains("citadel_server api="))
    {
        let wait = deadline.saturating_duration_since(Instant::now());
        match received.recv_timeout(wait) {
            Ok(line) => seen.push(line),
            Err(_) => panic!("server did not start: {seen:#?}"),
        }
    }
    let log = seen.join("\n");
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
    let (lines, received) = mpsc::channel();
    for stream in [
        Box::new(child.stdout.take().unwrap()) as Box<dyn std::io::Read + Send>,
        Box::new(child.stderr.take().unwrap()),
    ] {
        let lines = lines.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let _ = lines.send(line);
            }
        });
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut seen = Vec::new();
    // stdout and stderr are read on their own threads, so wait for both.
    let logged = |seen: &[String], text: &str| seen.iter().any(|line| line.contains(text));
    while !logged(&seen, "health=failing") || !logged(&seen, "newer version of Citadel") {
        let wait = deadline.saturating_duration_since(Instant::now());
        match received.recv_timeout(wait) {
            Ok(line) => seen.push(line),
            Err(_) => panic!("server did not keep answering: {seen:#?}"),
        }
    }

    let mut health = Command::new(env!("CARGO_BIN_EXE_citadel-server"));
    with_settings(&mut health);
    let output = health.arg("health").output().unwrap();
    assert!(!output.status.success());
    let said = String::from_utf8_lossy(&output.stderr);
    assert!(said.contains("health=failing database=failing"), "{said}");

    let client = reqwest::blocking::Client::new();
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

    kill(Pid::from_raw(child.id() as i32), Signal::SIGTERM).unwrap();
    let status = child.wait().unwrap();
    assert!(!status.success(), "stopping still reports the failure");
}

/// A small JPEG, so the committed book's cover can be checked.
fn jpeg() -> Vec<u8> {
    let mut bytes = Vec::new();
    image::RgbImage::from_pixel(4, 4, image::Rgb([200, 40, 40]))
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Jpeg,
        )
        .unwrap();
    bytes
}

#[test]
fn hostile_epubs_are_refused_and_server_survives() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let library_path = directory.path().join("library");
    drop(Library::create_library_at(library_path.to_str().unwrap()).unwrap());
    let api_port = free_port();
    let with_settings = |command: &mut Command| {
        command
            .env_remove("CITADEL_CONFIG")
            .env("CITADEL_LISTEN", format!("127.0.0.1:{api_port}"))
            .env("CITADEL_OPDS_PORT", free_port().to_string())
            .env("CITADEL_STATE_DIRECTORY", &state);
    };
    let admin = |args: &[&str], stdin: &str| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_citadel-server"));
        with_settings(&mut command);
        let mut child = command
            .args(args)
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
    };
    admin(&["libraries", "add", library_path.to_str().unwrap()], "");
    admin(
        &["users", "add", "admin", "--password-stdin", "--admin"],
        "admin-password\n",
    );

    let mut command = Command::new(env!("CARGO_BIN_EXE_citadel-server"));
    with_settings(&mut command);
    let mut child = ServerProcess(
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let (lines, received) = mpsc::channel();
    for stream in [
        Box::new(child.stdout.take().unwrap()) as Box<dyn std::io::Read + Send>,
        Box::new(child.stderr.take().unwrap()),
    ] {
        let lines = lines.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let _ = lines.send(line);
            }
        });
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut seen = Vec::new();
    while !seen
        .iter()
        .any(|line: &String| line.contains("citadel_server api="))
    {
        let wait = deadline.saturating_duration_since(Instant::now());
        match received.recv_timeout(wait) {
            Ok(line) => seen.push(line),
            Err(_) => panic!("server did not start: {seen:#?}"),
        }
    }

    let origin = format!("http://127.0.0.1:{api_port}");
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap();
    let signed_in = client
        .post(format!("{origin}/api/session"))
        .header("content-type", "application/json")
        .header("origin", &origin)
        .body(r#"{"username":"admin","password":"admin-password"}"#)
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
    let upload = |name: &str, bytes: Vec<u8>| -> (u16, serde_json::Value, String) {
        let created = client
            .post(format!("{origin}/api/uploads"))
            .header("content-type", "application/json")
            .header("origin", &origin)
            .header("cookie", &cookie)
            .body(serde_json::json!({"fileName": name, "size": bytes.len()}).to_string())
            .send()
            .unwrap();
        assert_eq!(created.status(), 201, "{name}");
        let id = created.json::<serde_json::Value>().unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let sent = client
            .patch(format!("{origin}/api/uploads/{id}/content"))
            .header("content-type", "application/octet-stream")
            .header("origin", &origin)
            .header("cookie", &cookie)
            .header("upload-offset", "0")
            .body(bytes)
            .send()
            .unwrap();
        let status = sent.status().as_u16();
        (status, sent.json().unwrap(), id)
    };
    let alive = |child: &mut ServerProcess| {
        assert!(child.try_wait().unwrap().is_none(), "the server is running");
        let health = client.get(format!("{origin}/api/health")).send().unwrap();
        assert_eq!(health.status(), 200);
    };

    for (name, build) in citadel_epub::fixtures::hostile() {
        let (status, body, id) = upload(&format!("{name}.epub"), build());
        assert_eq!(status, 422, "{name}: {body}");
        assert_eq!(body["code"], "unprocessable", "{name}: {body}");
        let reason = body["message"].as_str().unwrap();
        assert!(reason.starts_with("This EPUB"), "{name}: {reason}");
        let gone = client
            .get(format!("{origin}/api/uploads/{id}"))
            .header("cookie", &cookie)
            .send()
            .unwrap();
        assert_eq!(gone.status(), 404, "{name}: a refused upload is discarded");
        alive(&mut child);
    }

    let book = citadel_epub::fixtures::Builder::book(
        r#"<dc:identifier id="id">urn:isbn:9780306406157</dc:identifier><dc:title>Survivor</dc:title><dc:creator>Ann Author</dc:creator>"#,
        r#"<item id="c" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>"#,
    )
    .entry("OEBPS/cover.jpg", jpeg())
    .build();
    let (status, staged, id) = upload("Survivor.epub", book);
    assert_eq!(status, 200, "{staged}");
    assert_eq!(staged["book"]["title"], "Survivor");
    assert!(staged["book"]["coverUrl"].is_string(), "{staged}");
    let committed = client
        .post(format!("{origin}/api/uploads/{id}/commit"))
        .header("content-type", "application/json")
        .header("origin", &origin)
        .header("cookie", &cookie)
        .body(r#"{"title":"Survivor","authorNames":["Ann Author"]}"#)
        .send()
        .unwrap();
    assert_eq!(committed.status(), 201);
    let added: serde_json::Value = committed.json().unwrap();
    assert_eq!(added["title"], "Survivor");
    assert!(!added["cover_image"].is_null(), "{added}");
    alive(&mut child);
}

/// Peak resident memory (`VmHWM`), in KiB.
#[cfg(target_os = "linux")]
fn peak_memory(pid: u32) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .and_then(|value| value.trim().trim_end_matches("kB").trim().parse().ok())
        .unwrap()
}

#[test]
fn sign_in_flood() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let api_port = free_port();
    let opds_port = free_port();
    let with_settings = |command: &mut Command| {
        command
            .env_remove("CITADEL_CONFIG")
            .env("CITADEL_LISTEN", format!("127.0.0.1:{api_port}"))
            .env("CITADEL_OPDS_PORT", opds_port.to_string())
            .env("CITADEL_STATE_DIRECTORY", &state)
            .env("CITADEL_UPDATE_CHECK", "false");
    };
    let mut add = Command::new(env!("CARGO_BIN_EXE_citadel-server"));
    with_settings(&mut add);
    let mut adding = add
        .args(["users", "add", "admin", "--admin", "--password-stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    std::io::Write::write_all(&mut adding.stdin.take().unwrap(), b"the right password\n").unwrap();
    assert!(adding.wait().unwrap().success());

    let mut command = Command::new(env!("CARGO_BIN_EXE_citadel-server"));
    with_settings(&mut command);
    let mut child = ServerProcess(
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let stdout = child.stdout.take().unwrap();
    let (lines, received) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = lines.send(line);
        }
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let wait = deadline.saturating_duration_since(Instant::now());
        match received.recv_timeout(wait) {
            Ok(line) if line.contains("citadel_server api=") => break,
            Ok(_) => {}
            Err(_) => panic!("server did not start"),
        }
    }
    let origin = format!("http://127.0.0.1:{api_port}");
    let client = || {
        reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap()
    };
    let sign_in = |client: &reqwest::blocking::Client, password: &str| {
        client
            .post(format!("{origin}/api/session"))
            .header("content-type", "application/json")
            .header("origin", &origin)
            .body(format!(r#"{{"username":"admin","password":"{password}"}}"#))
    };
    // A second client: another loopback address on Linux; elsewhere only
    // 127.0.0.1 exists, so it says who it is through a trusted proxy (this
    // machine) instead.
    let elsewhere = |client: &str, request: reqwest::blocking::RequestBuilder| {
        if cfg!(target_os = "linux") {
            request
        } else {
            request.header("x-forwarded-for", client)
        }
    };
    let from = |address: [u8; 4]| {
        let builder = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(30));
        #[cfg(target_os = "linux")]
        let builder = builder.local_address(std::net::IpAddr::from(address));
        #[cfg(not(target_os = "linux"))]
        let _ = address;
        builder.build().unwrap()
    };
    let browser = from([127, 0, 0, 2]);
    let first = elsewhere("198.51.100.2", sign_in(&browser, "the right password"))
        .send()
        .unwrap();
    assert_eq!(first.status(), 200);
    let device = first
        .headers()
        .get_all("set-cookie")
        .iter()
        .map(|value| {
            value
                .to_str()
                .unwrap()
                .split(';')
                .next()
                .unwrap()
                .to_string()
        })
        .find(|cookie| cookie.starts_with("citadel_device="))
        .unwrap();

    #[cfg(target_os = "linux")]
    let memory_before = peak_memory(child.id());

    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let health = {
        let stop = stop.clone();
        let url = format!("{origin}/api/health");
        let client = client();
        std::thread::spawn(move || {
            let mut statuses = Vec::new();
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                statuses.push(client.get(&url).send().map(|response| response.status()));
                std::thread::sleep(Duration::from_millis(100));
            }
            statuses
        })
    };
    let start = std::sync::Arc::new(std::sync::Barrier::new(64));
    let flood: Vec<_> = (0..64)
        .map(|attempt| {
            let request = sign_in(&client(), &format!("wrong password {attempt}"));
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                request.send().map(|response| response.status())
            })
        })
        .collect();
    let statuses: Vec<u16> = flood
        .into_iter()
        .map(|attempt| attempt.join().unwrap().unwrap().as_u16())
        .collect();
    std::thread::sleep(Duration::from_millis(500));
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let health = health.join().unwrap();
    assert!(!health.is_empty());
    assert!(
        health
            .iter()
            .all(|status| matches!(status, Ok(status) if status.as_u16() == 200)),
        "{health:?}"
    );
    // At most two at a time, and no more than the username's burst of ten
    // in all, were checked; the rest were refused without a check.
    assert!(
        statuses.iter().filter(|status| **status == 401).count() <= 10,
        "{statuses:?}"
    );
    assert!(
        statuses
            .iter()
            .all(|status| matches!(status, 401 | 429 | 503)),
        "{statuses:?}"
    );
    #[cfg(target_os = "linux")]
    {
        let grew = peak_memory(child.id()).saturating_sub(memory_before);
        assert!(grew < 200 * 1024, "peak memory grew {grew} KiB");
    }

    // The administrator's browser is known, so it gets straight in.
    let signed_in = elsewhere(
        "198.51.100.2",
        sign_in(&browser, "the right password").header("cookie", &device),
    )
    .send()
    .unwrap();
    assert_eq!(signed_in.status(), 200);
    // A new device is answered at once: in, or told how long to wait.
    let new_device = elsewhere(
        "198.51.100.3",
        sign_in(&from([127, 0, 0, 3]), "the right password"),
    )
    .send()
    .unwrap();
    match new_device.status().as_u16() {
        200 => {}
        429 => {
            let wait: u64 = new_device.headers()["retry-after"]
                .to_str()
                .unwrap()
                .parse()
                .unwrap();
            assert!((1..=30).contains(&wait), "{wait}");
        }
        status => panic!("new device got {status}"),
    }
}
