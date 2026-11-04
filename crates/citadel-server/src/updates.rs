//! Whether a newer Citadel has been released. The server asks GitHub for the
//! latest release once a day and tells administrators; it sends nothing about
//! itself or its users to do so.
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

const LATEST_RELEASE: &str =
    "https://api.github.com/repos/everydaythingssoftware/citadel/releases/latest";
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateConfig {
    /// Look for new releases. On by default for release builds.
    pub check: Option<bool>,
}

/// Whether this server looks for new releases.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum UpdateChecks {
    On,
    /// Turned off in the server's settings.
    Off,
    /// A nightly or development build, which has no release to compare with.
    NotForThisBuild,
}

impl UpdateChecks {
    /// Release builds check unless told not to. Prereleases never do: the
    /// latest release would read as older or equal. Development builds check
    /// only when asked to, so tests and local runs stay offline.
    pub fn for_build(config: &UpdateConfig, version: &str, release_build: bool) -> Self {
        let prerelease = semver::Version::parse(version)
            .map(|version| !version.pre.is_empty())
            .unwrap_or(true);
        match config.check {
            Some(false) => Self::Off,
            _ if prerelease => Self::NotForThisBuild,
            Some(true) => Self::On,
            None if release_build => Self::On,
            None => Self::NotForThisBuild,
        }
    }
}

/// A published Citadel release.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    /// The release notes page.
    pub url: String,
    pub published_at: Option<DateTime<Utc>>,
}

/// What administrators see about updates.
#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub checks: UpdateChecks,
    /// A release newer than this server, once a check has found one.
    pub available: Option<Release>,
    /// When the server last heard from GitHub.
    pub checked_at: Option<DateTime<Utc>>,
}

#[derive(Default)]
struct Found {
    latest: Option<Release>,
    checked_at: Option<DateTime<Utc>>,
}

pub struct Updates {
    current: semver::Version,
    current_text: String,
    checks: UpdateChecks,
    feed: String,
    found: Mutex<Found>,
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    published_at: Option<DateTime<Utc>>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

impl Updates {
    pub fn new(version: &str, checks: UpdateChecks) -> Arc<Self> {
        Self::with_feed(version, checks, LATEST_RELEASE)
    }

    /// For tests that stand in for GitHub.
    pub fn with_feed(version: &str, checks: UpdateChecks, feed: &str) -> Arc<Self> {
        Arc::new(Self {
            current: semver::Version::parse(version)
                .unwrap_or_else(|_| semver::Version::new(0, 0, 0)),
            current_text: version.into(),
            checks,
            feed: feed.into(),
            found: Mutex::default(),
        })
    }

    /// Never checks; for tests and builds that don't.
    pub fn off() -> Arc<Self> {
        Self::new(crate::release::VERSION, UpdateChecks::Off)
    }

    pub fn checks(&self) -> UpdateChecks {
        self.checks
    }

    pub fn status(&self) -> UpdateStatus {
        let found = self.lock();
        UpdateStatus {
            current_version: self.current_text.clone(),
            checks: self.checks,
            available: found
                .latest
                .clone()
                .filter(|release| self.is_newer(&release.version)),
            checked_at: found.checked_at,
        }
    }

    fn is_newer(&self, version: &str) -> bool {
        semver::Version::parse(version).is_ok_and(|version| version > self.current)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Found> {
        self.found
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Asks once. Failures are logged and leave the last answer in place.
    pub async fn check_now(&self, client: &reqwest::Client) -> Result<(), String> {
        let response = client
            .get(&self.feed)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .send()
            .await
            .map_err(|error| format!("could not reach GitHub: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("GitHub answered {}", response.status()));
        }
        let release: GitHubRelease = response
            .json()
            .await
            .map_err(|error| format!("unexpected answer from GitHub: {error}"))?;
        let latest = (!release.draft && !release.prerelease)
            .then(|| {
                let version = release.tag_name.trim_start_matches('v');
                semver::Version::parse(version).ok().map(|_| Release {
                    version: version.into(),
                    url: release.html_url,
                    published_at: release.published_at,
                })
            })
            .flatten();
        let mut found = self.lock();
        if latest.is_some() {
            found.latest = latest;
        }
        found.checked_at = Some(Utc::now());
        if let Some(release) = found
            .latest
            .as_ref()
            .filter(|release| self.is_newer(&release.version))
        {
            println!(
                "citadel_server update_available={} url={}",
                release.version, release.url
            );
        }
        Ok(())
    }

    /// Checks now and then daily, while checks are on.
    pub fn spawn(self: &Arc<Self>) {
        if self.checks != UpdateChecks::On {
            return;
        }
        let updates = self.clone();
        tokio::spawn(async move {
            // No version or other detail about this server in the request.
            let client = match reqwest::Client::builder()
                .user_agent("citadel-server")
                .timeout(Duration::from_secs(30))
                .build()
            {
                Ok(client) => client,
                Err(error) => {
                    eprintln!("citadel_server warning=\"update checks are off: {error}\"");
                    return;
                }
            };
            loop {
                let wait = match updates.check_now(&client).await {
                    Ok(()) => CHECK_EVERY,
                    Err(error) => {
                        eprintln!(
                            "citadel_server warning=\"could not check for updates: {error}\""
                        );
                        RETRY_AFTER_FAILURE
                    }
                };
                tokio::time::sleep(wait).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_builds_check_unless_turned_off_and_prereleases_never_do() {
        let default = UpdateConfig::default();
        let on = UpdateConfig { check: Some(true) };
        let off = UpdateConfig { check: Some(false) };
        assert_eq!(
            UpdateChecks::for_build(&default, "0.8.0", true),
            UpdateChecks::On
        );
        assert_eq!(
            UpdateChecks::for_build(&off, "0.8.0", true),
            UpdateChecks::Off
        );
        assert_eq!(
            UpdateChecks::for_build(&default, "0.8.0", false),
            UpdateChecks::NotForThisBuild
        );
        assert_eq!(
            UpdateChecks::for_build(&on, "0.8.0", false),
            UpdateChecks::On
        );
        assert_eq!(
            UpdateChecks::for_build(&on, "0.8.0-nightly.20261104.42", true),
            UpdateChecks::NotForThisBuild
        );
        assert_eq!(
            UpdateChecks::for_build(&off, "0.8.0-nightly.20261104.42", true),
            UpdateChecks::Off
        );
    }

    #[test]
    fn only_a_newer_release_is_offered() {
        let updates = Updates::off();
        let updates = Updates::with_feed("0.8.0", updates.checks(), "");
        for (latest, offered) in [
            ("0.7.9", false),
            ("0.8.0", false),
            ("0.8.1", true),
            ("1.0.0", true),
        ] {
            updates.lock().latest = Some(Release {
                version: latest.into(),
                url: String::new(),
                published_at: None,
            });
            assert_eq!(updates.status().available.is_some(), offered, "{latest}");
        }
    }
}
