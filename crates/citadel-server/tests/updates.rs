//! The update check against a stand-in for GitHub's latest-release answer.
use std::sync::{Arc, Mutex};

use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Json, Router};
use citadel_server::updates::{UpdateChecks, Updates};
use serde_json::{json, Value};

type Answer = Arc<Mutex<(StatusCode, Value)>>;

async fn latest(State(answer): State<Answer>) -> impl IntoResponse {
    let (status, body) = answer.lock().unwrap().clone();
    (status, Json(body))
}

async fn stand_in(answer: Answer) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/releases/latest", get(latest))
        .with_state(answer);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}/releases/latest")
}

fn release(tag: &str) -> Value {
    json!({
        "tag_name": tag,
        "html_url": format!("https://github.com/everydaythingssoftware/citadel/releases/tag/{tag}"),
        "published_at": "2026-11-04T12:00:00Z",
        "draft": false,
        "prerelease": false,
    })
}

#[tokio::test]
async fn a_newer_release_is_offered_and_kept_through_a_failed_check() {
    let answer: Answer = Arc::new(Mutex::new((StatusCode::OK, release("v0.7.1"))));
    let feed = stand_in(answer.clone()).await;
    let updates = Updates::with_feed("0.7.1", UpdateChecks::On, &feed);
    let client = reqwest::Client::new();

    updates.check_now(&client).await.unwrap();
    let status = updates.details();
    assert!(
        status.available.is_none(),
        "the same version isn't an update"
    );
    assert!(status.checked_at.is_some());

    *answer.lock().unwrap() = (StatusCode::OK, release("v0.8.0"));
    updates.check_now(&client).await.unwrap();
    let available = updates.details().available.expect("0.8.0 is newer");
    assert_eq!(available.version, "0.8.0");
    assert_eq!(
        available.url,
        "https://github.com/everydaythingssoftware/citadel/releases/tag/v0.8.0"
    );

    *answer.lock().unwrap() = (StatusCode::SERVICE_UNAVAILABLE, json!({}));
    assert!(updates.check_now(&client).await.is_err());
    assert_eq!(
        updates.details().available.map(|release| release.version),
        Some("0.8.0".into()),
        "a failed check keeps what the last one found"
    );
}

#[tokio::test]
async fn drafts_prereleases_and_odd_tags_are_not_offered() {
    let answer: Answer = Arc::new(Mutex::new((StatusCode::OK, Value::Null)));
    let feed = stand_in(answer.clone()).await;
    let updates = Updates::with_feed("0.7.1", UpdateChecks::On, &feed);
    let client = reqwest::Client::new();
    for body in [
        json!({"tag_name": "v9.0.0", "html_url": "x", "published_at": null, "draft": true, "prerelease": false}),
        json!({"tag_name": "v9.0.0-nightly.1", "html_url": "x", "published_at": null, "draft": false, "prerelease": true}),
        json!({"tag_name": "latest", "html_url": "x", "published_at": null}),
    ] {
        *answer.lock().unwrap() = (StatusCode::OK, body.clone());
        updates.check_now(&client).await.unwrap();
        assert!(updates.details().available.is_none(), "{body}");
    }
}
