//! How each part of the server is doing. Anyone may ask (container health
//! checks, uptime monitors); signed-in administrators also get the reasons,
//! which can name paths on the server.
//!
//! Anonymous checks are answered outside admission from a result a
//! background task refreshes every two seconds, so a flood of them does no
//! database work and a server whose admission is full still says it is up
//! (ADR 0017). A request with a session cookie takes the admitted path and
//! is checked afresh, with the reasons for administrators.
use std::{path::Path, sync::Arc, time::Duration};

use axum::{
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use citadel_opds::OpdsLifecycleState;
use serde::Serialize;
use tokio::sync::{watch, Semaphore};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::{
    session::{current_user, has_session_cookie},
    ApiState,
};

/// How often the anonymous answer is refreshed.
const REFRESH: Duration = Duration::from_secs(2);
/// Anonymous checks answered at once; the rest get the same cached answer
/// without waiting, or are told to retry while there is none yet.
const ANONYMOUS_PERMITS: usize = 8;
const FIRST_RESULT_WAIT: Duration = Duration::from_secs(5);

/// Below this much free space, writes start failing: Citadel's own database
/// on the state volume, new books on the library's.
const NEARLY_FULL_BYTES: u64 = 1_000_000_000;
const FULL_BYTES: u64 = 50_000_000;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum HealthStatus {
    Ok,
    /// Working, with something an administrator should look at.
    Degraded,
    /// The server can't do its job.
    Failing,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheck {
    /// `database`, `providerKeys`, `library`, `webApp`, `opds`, `metadata`,
    /// `stateDisk` or `libraryDisk`.
    pub name: String,
    pub status: HealthStatus,
    /// What is wrong or how it stands. Administrators only.
    #[schema(required = true)]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    /// The worst of the checks.
    pub status: HealthStatus,
    pub checks: Vec<HealthCheck>,
}

impl Health {
    pub fn of(checks: Vec<HealthCheck>) -> Self {
        Self {
            status: checks
                .iter()
                .map(|check| check.status)
                .max()
                .unwrap_or(HealthStatus::Ok),
            checks,
        }
    }

    /// Without the details, for anyone who isn't an administrator.
    pub fn public(mut self) -> Self {
        for check in &mut self.checks {
            check.detail = None;
        }
        self
    }

    pub fn into_response(self) -> Response {
        let status = if self.status == HealthStatus::Failing {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::OK
        };
        (status, Json(self)).into_response()
    }
}

fn check(name: &str, status: HealthStatus, detail: impl Into<String>) -> HealthCheck {
    HealthCheck {
        name: name.into(),
        status,
        detail: Some(detail.into()),
    }
}

#[utoipa::path(get, path = "/api/health", operation_id = "getHealth",
    description = "How each part of the server is doing. 200 while it can serve, 503 when it can't. Answers at any address; the reasons are for signed-in administrators only. Without a session cookie the answer is at most two seconds old and is served even while the server is busy.",
    responses((status = 200, body = Health), (status = 503, body = Health)))]
async fn health(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    let administrator = matches!(
        current_user(&state, &headers).await,
        Ok(Some((user, _))) if user.is_administrator()
    );
    let health = Health::of(checks(&state).await);
    if administrator {
        health.into_response()
    } else {
        health.public().into_response()
    }
}

/// The latest anonymous answer, refreshed in the background until the
/// router that owns it is dropped.
#[derive(Clone)]
pub(super) struct HealthCache {
    latest: watch::Receiver<Option<Arc<Health>>>,
    permits: Arc<Semaphore>,
}

impl HealthCache {
    pub(super) fn spawn(state: ApiState) -> Self {
        let (sender, latest) = watch::channel(None);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(REFRESH);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                // Stop as soon as the router is gone, so its library closes.
                tokio::select! {
                    _ = interval.tick() => {}
                    () = sender.closed() => return,
                }
                let health = Health::of(checks(&state).await).public();
                if sender.send(Some(Arc::new(health))).is_err() {
                    return;
                }
            }
        });
        Self {
            latest,
            permits: Arc::new(Semaphore::new(ANONYMOUS_PERMITS)),
        }
    }

    async fn answer(&self) -> Response {
        let cached = self.latest.borrow().clone();
        let Ok(_permit) = self.permits.try_acquire() else {
            return cached.map_or_else(starting, |health| (*health).clone().into_response());
        };
        if let Some(health) = cached {
            return (*health).clone().into_response();
        }
        let mut latest = self.latest.clone();
        let first = tokio::time::timeout(FIRST_RESULT_WAIT, latest.wait_for(Option::is_some))
            .await
            .ok()
            .and_then(|waited| waited.ok().and_then(|health| health.clone()));
        first.map_or_else(starting, |health| (*health).clone().into_response())
    }
}

fn starting() -> Response {
    let mut response = Health::of(vec![HealthCheck {
        name: "database".into(),
        status: HealthStatus::Failing,
        detail: None,
    }])
    .into_response();
    response
        .headers_mut()
        .insert(axum::http::header::RETRY_AFTER, "1".parse().unwrap());
    response
}

/// `/api/version`, and `/api/health` without a session cookie, answered
/// before admission.
pub(super) async fn outside_admission(
    State(cache): State<HealthCache>,
    request: Request,
    next: Next,
) -> Response {
    let reading = matches!(*request.method(), Method::GET | Method::HEAD);
    match request.uri().path() {
        "/api/version" if reading => super::server::version_json().into_response(),
        "/api/health" if reading && !has_session_cookie(request.headers()) => cache.answer().await,
        _ => next.run(request).await,
    }
}

async fn checks(state: &ApiState) -> Vec<HealthCheck> {
    let served = state.access.served.clone();
    let secrets = state.secrets.clone();
    let mut checks = tokio::task::spawn_blocking(move || {
        let accounts = served.accounts();
        let mut checks = vec![match accounts.administrator_exists() {
            Ok(_) => check("database", HealthStatus::Ok, "citadel.db answers"),
            Err(error) => check("database", HealthStatus::Failing, format!("citadel.db: {error}")),
        }];
        checks.push(match accounts.unreadable_provider_credentials(&secrets) {
            Ok(0) => check("providerKeys", HealthStatus::Ok, "Saved provider keys can be read"),
            Ok(count) => check(
                "providerKeys",
                HealthStatus::Degraded,
                format!(
                    "{count} saved provider key(s) were sealed with a different vault key; their users must enter them again"
                ),
            ),
            Err(error) => check("providerKeys", HealthStatus::Degraded, error.to_string()),
        });
        checks.push(library_check(&served));
        checks.push(disk_check("stateDisk", served.state_directory(), HealthStatus::Failing));
        if let Some(info) = served.info() {
            checks.push(disk_check("libraryDisk", Path::new(&info.path), HealthStatus::Degraded));
        }
        checks
    })
    .await
    .unwrap_or_else(|_| {
        vec![check("database", HealthStatus::Failing, "The health check itself failed")]
    });

    if let Some(directory) = &state.web_directory {
        checks.push(if directory.join("index.html").is_file() {
            check(
                "webApp",
                HealthStatus::Ok,
                format!("Served from {}", directory.display()),
            )
        } else {
            check(
                "webApp",
                HealthStatus::Degraded,
                format!(
                    "The web app's files are missing from {}",
                    directory.display()
                ),
            )
        });
    }

    let opds = state.opds.status().await;
    checks.push(match (opds.state, state.source.is_open()) {
        // Which URL an e-reader should use is for the Sharing settings: the
        // listener's own addresses mean little from outside a container.
        (OpdsLifecycleState::Running, _) => check("opds", HealthStatus::Ok, "Serving e-readers"),
        (OpdsLifecycleState::Error, _) => check(
            "opds",
            HealthStatus::Degraded,
            opds.error
                .map(|error| error.message)
                .unwrap_or_else(|| "OPDS stopped with an error".into()),
        ),
        (OpdsLifecycleState::WaitingForInterface, _) => check(
            "opds",
            HealthStatus::Degraded,
            "Waiting for a network interface to listen on",
        ),
        (_, false) => check("opds", HealthStatus::Ok, "Starts once a library is set up"),
        (_, true) => check(
            "opds",
            HealthStatus::Ok,
            "Starts once someone has access to the library",
        ),
    });

    let skipped = state.metadata.skipped_providers();
    checks.push(if skipped.is_empty() {
        check("metadata", HealthStatus::Ok, "Book lookups are available")
    } else {
        check(
            "metadata",
            HealthStatus::Degraded,
            skipped
                .iter()
                .map(|(provider, remaining)| {
                    format!(
                        "{} failed repeatedly and is skipped for {}",
                        provider.display_name(),
                        seconds(*remaining)
                    )
                })
                .collect::<Vec<_>>()
                .join("; "),
        )
    });
    checks
}

fn seconds(duration: Duration) -> String {
    format!("{} s", duration.as_secs().max(1))
}

fn library_check(served: &crate::served::ServedLibrary) -> HealthCheck {
    match served.info() {
        None => check(
            "library",
            HealthStatus::Degraded,
            "No library is set up yet",
        ),
        Some(info) if !info.available => check(
            "library",
            HealthStatus::Degraded,
            format!(
                "{} at {} can't be opened: {}",
                info.name,
                info.path,
                info.problem.unwrap_or_default()
            ),
        ),
        Some(info) if info.read_only && !info.read_only_chosen => check(
            "library",
            HealthStatus::Degraded,
            info.read_only_reason.unwrap_or_else(|| {
                format!(
                    "{} at {} is read-only: Citadel can't change it",
                    info.name, info.path
                )
            }),
        ),
        Some(info) if info.read_only => check(
            "library",
            HealthStatus::Ok,
            format!("{} at {}, served read-only as chosen", info.name, info.path),
        ),
        Some(info) => check(
            "library",
            HealthStatus::Ok,
            format!("{} at {}", info.name, info.path),
        ),
    }
}

/// Free space where `path` lives. Nearly full is degraded; full is `full`.
fn disk_check(name: &str, path: &Path, full: HealthStatus) -> HealthCheck {
    match free_bytes(path) {
        None => check(
            name,
            HealthStatus::Ok,
            format!("Free space at {} is unknown", path.display()),
        ),
        Some(free) if free < FULL_BYTES => check(
            name,
            full,
            format!(
                "{} free at {}: writes will fail",
                gigabytes(free),
                path.display()
            ),
        ),
        Some(free) if free < NEARLY_FULL_BYTES => check(
            name,
            HealthStatus::Degraded,
            format!("Only {} free at {}", gigabytes(free), path.display()),
        ),
        Some(free) => check(
            name,
            HealthStatus::Ok,
            format!("{} free at {}", gigabytes(free), path.display()),
        ),
    }
}

fn gigabytes(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1e9)
}

#[cfg(unix)]
fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is NUL-terminated and `stats` is written before it is read.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: statvfs succeeded, so it filled `stats`.
    let stats = unsafe { stats.assume_init() };
    #[allow(clippy::unnecessary_cast)]
    Some(stats.f_bavail as u64 * stats.f_frsize as u64)
}

#[cfg(not(unix))]
fn free_bytes(_path: &Path) -> Option<u64> {
    None
}

pub(super) fn routes() -> OpenApiRouter<ApiState> {
    OpenApiRouter::new().routes(routes!(health))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_worst_check_decides_and_the_public_answer_has_no_details() {
        let health = Health::of(vec![
            check("database", HealthStatus::Ok, "citadel.db answers"),
            check(
                "library",
                HealthStatus::Degraded,
                "No library is set up yet",
            ),
        ]);
        assert_eq!(health.status, HealthStatus::Degraded);
        assert!(health
            .public()
            .checks
            .iter()
            .all(|check| check.detail.is_none()));
        let failing = Health::of(vec![check("database", HealthStatus::Failing, "broken")]);
        assert_eq!(
            failing.into_response().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(Health::of(vec![]).status, HealthStatus::Ok);
    }

    #[test]
    fn disk_space_is_reported_in_gigabytes() {
        let directory = tempfile::tempdir().unwrap();
        let space = disk_check("stateDisk", directory.path(), HealthStatus::Failing);
        let detail = space.detail.unwrap();
        if cfg!(unix) {
            assert!(detail.contains(" GB free at "), "{detail}");
        } else {
            assert!(detail.contains("is unknown"), "{detail}");
            assert_eq!(space.status, HealthStatus::Ok);
        }
        assert_eq!(gigabytes(1_250_000_000), "1.2 GB");
    }
}
