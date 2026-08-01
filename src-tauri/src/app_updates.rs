use tauri_plugin_updater::UpdaterExt;

use crate::opds::OpdsService;

#[derive(serde::Serialize, specta::Type)]
pub struct UpdateCheckResult {
    pub has_update: bool,
    pub version: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_check_for_updates(app: tauri::AppHandle) -> Result<UpdateCheckResult, String> {
    let updater = app
        .updater()
        .map_err(|err| format!("Updater initialization failed: {err}"))?;

    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateCheckResult {
            has_update: true,
            version: Some(update.version.to_string()),
        }),
        Ok(None) => Ok(UpdateCheckResult {
            has_update: false,
            version: None,
        }),
        Err(err) => Err(format!("Failed to check for updates: {err}")),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_install_update_if_available(
    app: tauri::AppHandle,
    opds: tauri::State<'_, OpdsService>,
) -> Result<String, String> {
    let updater = app
        .updater()
        .map_err(|err| format!("Updater initialization failed: {err}"))?;

    // We need a second check here because the updater's `Update` handle from the
    // first check is not serializable across the Tauri IPC boundary.
    match updater.check().await {
        Ok(Some(update)) => {
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|err| format!("Failed to download/install update: {err}"))?;

            opds.stop().await;
            app.restart();
        }
        Ok(None) => Ok("no-update".to_string()),
        Err(err) => Err(format!("Failed to check for updates: {err}")),
    }
}
