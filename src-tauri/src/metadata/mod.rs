//! Tauri adapters for the shared `citadel-metadata` providers.

pub mod commands;

use tauri::{
    http::{header, Request, Response, StatusCode},
    Manager, Runtime, UriSchemeContext, UriSchemeResponder,
};

/// Cover previews load from `citadel-cover://localhost/<cover_id>` (or
/// `http://citadel-cover.localhost/<cover_id>` on Windows), so the webview
/// never contacts provider hosts.
pub const COVER_SCHEME: &str = "citadel-cover";

pub fn client() -> citadel_metadata::MetadataClient {
    citadel_metadata::MetadataClient::new(citadel_metadata::ClientOptions {
        version: env!("CARGO_PKG_VERSION").into(),
        ..Default::default()
    })
    .expect("metadata HTTP client builds")
}

pub fn serve_cover_preview<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    let cover_id = request.uri().path().trim_start_matches('/').to_string();
    tauri::async_runtime::spawn(async move {
        let client = app.state::<citadel_metadata::MetadataClient>();
        let response = match client.cover_preview(&cover_id).await {
            Ok(bytes) => Response::builder()
                .header(header::CONTENT_TYPE, "image/jpeg")
                .header(header::CACHE_CONTROL, "private, max-age=180")
                .body(bytes.to_vec()),
            Err(error) => Response::builder()
                .status(match error.kind {
                    citadel_metadata::MetadataErrorKind::Gone => StatusCode::GONE,
                    _ => StatusCode::BAD_GATEWAY,
                })
                .body(Vec::new()),
        };
        responder.respond(response.expect("cover responses are valid"));
    });
}
