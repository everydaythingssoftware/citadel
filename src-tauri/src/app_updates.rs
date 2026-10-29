//! Software Update (CDL-51). One service owns the update state for every
//! window: it checks, downloads and installs, and broadcasts each change as
//! [`SoftwareUpdateChanged`]. "Later" downloads now and installs when
//! Citadel quits, where the install type allows it.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_specta::Event;

use citadel_opds::OpdsService;

const DEV_BUILD_MESSAGE: &str = "Development builds don't install updates.";
const DEV_DOWNLOAD_STEPS: u8 = 20;
const DEV_DOWNLOAD_STEP: Duration = Duration::from_millis(75);
const EXIT_INSTALL_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SoftwareUpdateStatus {
    Idle,
    Checking,
    UpToDate,
    Available {
        version: String,
    },
    Downloading {
        version: String,
        /// Fraction complete, 0–1; null when the server sends no size.
        progress: Option<f64>,
    },
    /// Downloaded and verified; installs when Citadel quits.
    Ready {
        version: String,
    },
    CheckFailed {
        message: String,
    },
    UpdateFailed {
        version: String,
        message: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareUpdateState {
    pub current_version: String,
    pub status: SoftwareUpdateStatus,
    /// False for .deb/.rpm installs, whose installer needs a password prompt
    /// that shouldn't appear at quit.
    pub can_install_on_quit: bool,
}

/// The update state after any change, for every window.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct SoftwareUpdateChanged(pub SoftwareUpdateState);

/// Asks an open Settings window to show General → Software Update.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct ShowSoftwareUpdate;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum UpdateNowOutcome {
    /// A check found nothing to install.
    NoUpdate,
    /// Another check or download is already running.
    Busy,
}

#[derive(Debug, PartialEq)]
enum Step {
    Nothing,
    CheckFirst,
    Download { then: AfterDownload },
    Install,
}

#[derive(Debug, PartialEq)]
enum AfterDownload {
    Install,
    WaitForQuit,
}

fn may_check(status: &SoftwareUpdateStatus) -> bool {
    !matches!(
        status,
        SoftwareUpdateStatus::Checking
            | SoftwareUpdateStatus::Downloading { .. }
            | SoftwareUpdateStatus::Ready { .. }
    )
}

fn later_step(status: &SoftwareUpdateStatus, can_install_on_quit: bool) -> Step {
    match status {
        SoftwareUpdateStatus::Available { .. } if can_install_on_quit => Step::Download {
            then: AfterDownload::WaitForQuit,
        },
        _ => Step::Nothing,
    }
}

fn update_now_step(status: &SoftwareUpdateStatus) -> Step {
    match status {
        SoftwareUpdateStatus::Available { .. } | SoftwareUpdateStatus::UpdateFailed { .. } => {
            Step::Download {
                then: AfterDownload::Install,
            }
        }
        SoftwareUpdateStatus::Ready { .. } => Step::Install,
        SoftwareUpdateStatus::Idle
        | SoftwareUpdateStatus::UpToDate
        | SoftwareUpdateStatus::CheckFailed { .. } => Step::CheckFirst,
        SoftwareUpdateStatus::Checking | SoftwareUpdateStatus::Downloading { .. } => Step::Nothing,
    }
}

fn download_progress(downloaded: u64, total: Option<u64>) -> Option<f64> {
    total
        .filter(|total| *total > 0)
        .map(|total| (downloaded as f64 / total as f64).min(1.0))
}

/// Publishes whole-percent steps only, so a download sends at most ~100
/// events rather than one per network chunk.
fn worth_publishing(last: Option<f64>, next: Option<f64>) -> bool {
    match (last, next) {
        (Some(last), Some(next)) => (next * 100.0).floor() > (last * 100.0).floor(),
        (None, Some(_)) => true,
        (_, None) => false,
    }
}

fn install_on_quit_supported(bundle: Option<tauri::utils::config::BundleType>) -> bool {
    use tauri::utils::config::BundleType;
    matches!(bundle, Some(BundleType::App | BundleType::AppImage))
}

struct Inner {
    status: SoftwareUpdateStatus,
    update: Option<Update>,
    /// The verified package, kept while "Later" waits for quit.
    bytes: Option<Vec<u8>>,
}

pub struct SoftwareUpdates {
    current_version: String,
    can_install_on_quit: bool,
    inner: Mutex<Inner>,
}

impl SoftwareUpdates {
    pub fn new(current_version: String) -> Self {
        Self {
            current_version,
            can_install_on_quit: install_on_quit_supported(tauri::utils::platform::bundle_type()),
            inner: Mutex::new(Inner {
                status: SoftwareUpdateStatus::Idle,
                update: None,
                bytes: None,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn state(&self) -> SoftwareUpdateState {
        SoftwareUpdateState {
            current_version: self.current_version.clone(),
            status: self.lock().status.clone(),
            can_install_on_quit: self.can_install_on_quit,
        }
    }

    fn set<R: Runtime>(&self, app: &AppHandle<R>, status: SoftwareUpdateStatus) {
        self.lock().status = status;
        self.broadcast(app);
    }

    fn broadcast<R: Runtime>(&self, app: &AppHandle<R>) {
        if let Err(err) = SoftwareUpdateChanged(self.state()).emit(app) {
            log::error!("Failed to broadcast update state: {err}");
        }
    }

    /// Moves to the next status only if `allowed` holds, in one step under
    /// the lock, so two presses can't both start the same work.
    fn claim<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        allowed: impl FnOnce(&Inner) -> bool,
        next: impl FnOnce(&Inner) -> SoftwareUpdateStatus,
    ) -> bool {
        {
            let mut inner = self.lock();
            if !allowed(&inner) {
                return false;
            }
            inner.status = next(&inner);
        }
        self.broadcast(app);
        true
    }

    /// Claims the found update for downloading; returns its version.
    fn begin_download<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        allowed: impl FnOnce(&SoftwareUpdateStatus) -> bool,
    ) -> Option<String> {
        let mut version = None;
        self.claim(
            app,
            |inner| inner.update.is_some() && allowed(&inner.status),
            |inner| {
                let found = inner
                    .update
                    .as_ref()
                    .map(|update| update.version.clone())
                    .unwrap_or_default();
                version = Some(found.clone());
                SoftwareUpdateStatus::Downloading {
                    version: found,
                    progress: None,
                }
            },
        );
        version
    }

    pub async fn check<R: Runtime>(&self, app: &AppHandle<R>) {
        if !self.claim(
            app,
            |inner| may_check(&inner.status),
            |_| SoftwareUpdateStatus::Checking,
        ) {
            return;
        }

        let result = match app.updater() {
            Ok(updater) => updater.check().await.map_err(|err| err.to_string()),
            Err(err) => Err(err.to_string()),
        };

        let status = {
            let mut inner = self.lock();
            inner.bytes = None;
            match result {
                Ok(Some(update)) => {
                    let version = update.version.clone();
                    inner.update = Some(update);
                    SoftwareUpdateStatus::Available { version }
                }
                Ok(None) => {
                    inner.update = None;
                    SoftwareUpdateStatus::UpToDate
                }
                Err(message) => {
                    inner.update = None;
                    SoftwareUpdateStatus::CheckFailed { message }
                }
            }
        };
        self.set(app, status);
    }

    pub async fn later<R: Runtime>(&self, app: &AppHandle<R>) {
        let can_install_on_quit = self.can_install_on_quit;
        let Some(version) = self.begin_download(app, |status| {
            later_step(status, can_install_on_quit) != Step::Nothing
        }) else {
            return;
        };
        if let Ok(bytes) = self.download(app, &version).await {
            self.lock().bytes = Some(bytes);
            self.set(app, SoftwareUpdateStatus::Ready { version });
        }
    }

    pub async fn update_now<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Result<UpdateNowOutcome, String> {
        if update_now_step(&self.lock().status) == Step::CheckFirst {
            self.check(app).await;
            if let SoftwareUpdateStatus::CheckFailed { message } = &self.lock().status {
                return Err(message.clone());
            }
        }

        let bytes = if let Some(bytes) = self.take_ready_bytes() {
            bytes
        } else if let Some(version) = self.begin_download(app, |status| {
            matches!(update_now_step(status), Step::Download { .. })
        }) {
            self.download(app, &version).await?
        } else {
            return Ok(match &self.lock().status {
                SoftwareUpdateStatus::Idle | SoftwareUpdateStatus::UpToDate => {
                    UpdateNowOutcome::NoUpdate
                }
                _ => UpdateNowOutcome::Busy,
            });
        };
        let Some(update) = self.lock().update.clone() else {
            return Err(self.fail(app, "The downloaded update is no longer available."));
        };

        let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes))
            .await
            .map_err(|err| err.to_string())
            .and_then(|result| result.map_err(|err| err.to_string()));
        if let Err(message) = installed {
            return Err(self.fail(app, &message));
        }

        if let Some(opds) = app.try_state::<OpdsService>() {
            opds.stop().await;
        }
        app.restart();
    }

    /// A package "Later" already downloaded, claimed for installing now.
    fn take_ready_bytes(&self) -> Option<Vec<u8>> {
        let mut inner = self.lock();
        if matches!(inner.status, SoftwareUpdateStatus::Ready { .. }) {
            inner.bytes.take()
        } else {
            None
        }
    }

    /// The pending update and its package, if "Later" left one for quit.
    pub fn take_install_for_quit(&self) -> Option<(Update, Vec<u8>)> {
        let mut inner = self.lock();
        if !matches!(inner.status, SoftwareUpdateStatus::Ready { .. }) {
            return None;
        }
        let bytes = inner.bytes.take()?;
        inner.update.clone().map(|update| (update, bytes))
    }

    fn pending_version(&self) -> String {
        self.lock()
            .update
            .as_ref()
            .map(|update| update.version.clone())
            .unwrap_or_default()
    }

    fn fail<R: Runtime>(&self, app: &AppHandle<R>, message: &str) -> String {
        self.set(
            app,
            SoftwareUpdateStatus::UpdateFailed {
                version: self.pending_version(),
                message: message.to_string(),
            },
        );
        message.to_string()
    }

    async fn download<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        version: &str,
    ) -> Result<Vec<u8>, String> {
        let Some(update) = self.lock().update.clone() else {
            return Err(self.fail(app, "No update to download."));
        };

        // Dev builds walk the progress bar instead of replacing themselves,
        // so the download UI can still be exercised.
        if cfg!(debug_assertions) {
            for step in 1..=DEV_DOWNLOAD_STEPS {
                tokio::time::sleep(DEV_DOWNLOAD_STEP).await;
                self.set(
                    app,
                    SoftwareUpdateStatus::Downloading {
                        version: version.to_string(),
                        progress: Some(f64::from(step) / f64::from(DEV_DOWNLOAD_STEPS)),
                    },
                );
            }
            return Err(self.fail(app, DEV_BUILD_MESSAGE));
        }

        let mut downloaded = 0u64;
        let mut published = None;
        let result = update
            .download(
                |chunk, total| {
                    downloaded += chunk as u64;
                    let progress = download_progress(downloaded, total);
                    if worth_publishing(published, progress) {
                        published = progress;
                        self.set(
                            app,
                            SoftwareUpdateStatus::Downloading {
                                version: version.to_string(),
                                progress,
                            },
                        );
                    }
                },
                || {},
            )
            .await;
        result.map_err(|err| self.fail(app, &err.to_string()))
    }
}

/// Installs a package "Later" left behind, as Citadel exits. Runs from
/// `RunEvent::Exit`, which every quit reaches (⌘Q skips `ExitRequested`).
/// The install gets its own thread and a deadline: an app in a folder it
/// can't write asks the main thread, which is busy exiting, for an admin
/// prompt, and that wait gives up before anything has moved. A failure
/// leaves the current version in place; the next check offers it again.
pub fn install_pending_at_exit<R: Runtime>(app: &AppHandle<R>) {
    let Some(updates) = app.try_state::<SoftwareUpdates>() else {
        return;
    };
    let Some((update, bytes)) = updates.take_install_for_quit() else {
        return;
    };
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(update.install(bytes));
    });
    match receiver.recv_timeout(EXIT_INSTALL_DEADLINE) {
        Ok(Ok(())) => log::info!("Installed the pending update at exit"),
        Ok(Err(err)) => log::error!("Failed to install the pending update at exit: {err}"),
        Err(err) => log::error!("Gave up installing the pending update at exit: {err}"),
    }
}

#[tauri::command]
#[specta::specta]
pub fn clb_query_software_update(
    updates: tauri::State<'_, SoftwareUpdates>,
) -> SoftwareUpdateState {
    updates.state()
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_check_for_updates(
    app: AppHandle,
    updates: tauri::State<'_, SoftwareUpdates>,
) -> Result<(), String> {
    updates.check(&app).await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_update_later(
    app: AppHandle,
    updates: tauri::State<'_, SoftwareUpdates>,
) -> Result<(), String> {
    updates.later(&app).await;
    Ok(())
}

/// Installs the available update and relaunches. With nothing checked yet
/// (the recovery screen), checks first.
#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_update_now(
    app: AppHandle,
    updates: tauri::State<'_, SoftwareUpdates>,
) -> Result<UpdateNowOutcome, String> {
    updates.update_now(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::utils::config::BundleType;

    fn available() -> SoftwareUpdateStatus {
        SoftwareUpdateStatus::Available {
            version: "0.7.2".into(),
        }
    }

    #[test]
    fn checks_wait_for_running_work_and_pending_installs() {
        assert!(may_check(&SoftwareUpdateStatus::Idle));
        assert!(may_check(&SoftwareUpdateStatus::UpToDate));
        assert!(may_check(&available()));
        assert!(may_check(&SoftwareUpdateStatus::CheckFailed {
            message: "offline".into()
        }));
        assert!(!may_check(&SoftwareUpdateStatus::Checking));
        assert!(!may_check(&SoftwareUpdateStatus::Downloading {
            version: "0.7.2".into(),
            progress: None
        }));
        assert!(!may_check(&SoftwareUpdateStatus::Ready {
            version: "0.7.2".into()
        }));
    }

    #[test]
    fn later_downloads_for_quit_only_where_quit_installs_work() {
        assert_eq!(
            later_step(&available(), true),
            Step::Download {
                then: AfterDownload::WaitForQuit
            }
        );
        assert_eq!(later_step(&available(), false), Step::Nothing);
        assert_eq!(
            later_step(&SoftwareUpdateStatus::UpToDate, true),
            Step::Nothing
        );
    }

    #[test]
    fn update_now_installs_whatever_is_furthest_along() {
        assert_eq!(
            update_now_step(&available()),
            Step::Download {
                then: AfterDownload::Install
            }
        );
        assert_eq!(
            update_now_step(&SoftwareUpdateStatus::UpdateFailed {
                version: "0.7.2".into(),
                message: "offline".into()
            }),
            Step::Download {
                then: AfterDownload::Install
            }
        );
        assert_eq!(
            update_now_step(&SoftwareUpdateStatus::Ready {
                version: "0.7.2".into()
            }),
            Step::Install
        );
        assert_eq!(
            update_now_step(&SoftwareUpdateStatus::Idle),
            Step::CheckFirst
        );
        assert_eq!(
            update_now_step(&SoftwareUpdateStatus::Checking),
            Step::Nothing
        );
    }

    #[test]
    fn progress_is_a_fraction_of_a_known_size() {
        assert_eq!(download_progress(50, Some(200)), Some(0.25));
        assert_eq!(download_progress(300, Some(200)), Some(1.0));
        assert_eq!(download_progress(50, None), None);
        assert_eq!(download_progress(50, Some(0)), None);
    }

    #[test]
    fn progress_publishes_whole_percent_steps() {
        assert!(worth_publishing(None, Some(0.0)));
        assert!(!worth_publishing(Some(0.101), Some(0.109)));
        assert!(worth_publishing(Some(0.109), Some(0.11)));
        assert!(!worth_publishing(None, None));
    }

    #[test]
    fn only_app_bundles_and_appimages_install_on_quit() {
        assert!(install_on_quit_supported(Some(BundleType::App)));
        assert!(install_on_quit_supported(Some(BundleType::AppImage)));
        assert!(!install_on_quit_supported(Some(BundleType::Deb)));
        assert!(!install_on_quit_supported(Some(BundleType::Rpm)));
        assert!(!install_on_quit_supported(None));
    }

    #[test]
    fn status_serializes_for_the_frontend() {
        let json = serde_json::to_value(SoftwareUpdateStatus::Downloading {
            version: "0.7.2".into(),
            progress: Some(0.5),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "downloading", "version": "0.7.2", "progress": 0.5 })
        );
        assert_eq!(
            serde_json::to_value(SoftwareUpdateStatus::UpToDate).unwrap(),
            serde_json::json!({ "kind": "upToDate" })
        );
    }
}
