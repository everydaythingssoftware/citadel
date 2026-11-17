use citadel_core::store::NewDeviceKey;
use citadel_opds::{
    service::{OpdsErrorCode, OpdsServiceStatus, OpdsStartConfig, OpdsStatusError},
    OpdsService,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_specta::Event;

use crate::account::{LocalAccount, OpdsDeviceKeys};

/// The sharing status after any change, for every window.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
pub struct OpdsStatusChanged(pub OpdsServiceStatus);

/// Sends every change of the sharing status to the windows as it happens.
pub fn broadcast_status_changes<R: Runtime>(service: &OpdsService, app: AppHandle<R>) {
    let service = service.clone();
    let mut changes = service.subscribe();
    tauri::async_runtime::spawn(async move {
        while changes.next().await.is_some() {
            let status = service.status().await;
            if let Err(error) = OpdsStatusChanged(status).emit(&app) {
                log::warn!("could not broadcast the sharing status: {error}");
            }
        }
    });
}

fn unexpected(message: String) -> OpdsStatusError {
    OpdsStatusError {
        code: OpdsErrorCode::Unexpected,
        message,
    }
}

/// The local user's device keys are the only credentials desktop sharing serves.
pub fn sync_credentials(
    service: &OpdsService,
    account: &LocalAccount,
) -> Result<(), OpdsStatusError> {
    service.replace_credentials(account.opds_verifiers().map_err(unexpected)?);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn clb_query_opds_device_keys(
    account: tauri::State<'_, LocalAccount>,
) -> Result<OpdsDeviceKeys, OpdsStatusError> {
    account.device_keys().map_err(unexpected)
}

/// The new key is returned once and hot-swapped into a running share.
#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_create_opds_device_key(
    service: tauri::State<'_, OpdsService>,
    account: tauri::State<'_, LocalAccount>,
    name: String,
) -> Result<NewDeviceKey, OpdsStatusError> {
    let created = account.create_device_key(&name).map_err(unexpected)?;
    sync_credentials(&service, &account)?;
    Ok(created)
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_rotate_opds_device_key(
    service: tauri::State<'_, OpdsService>,
    account: tauri::State<'_, LocalAccount>,
    key_id: String,
) -> Result<NewDeviceKey, OpdsStatusError> {
    let rotated = account.rotate_device_key(&key_id).map_err(unexpected)?;
    sync_credentials(&service, &account)?;
    Ok(rotated)
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_revoke_opds_device_key(
    service: tauri::State<'_, OpdsService>,
    account: tauri::State<'_, LocalAccount>,
    key_id: String,
) -> Result<OpdsDeviceKeys, OpdsStatusError> {
    account.revoke_device_key(&key_id).map_err(unexpected)?;
    sync_credentials(&service, &account)?;
    account.device_keys().map_err(unexpected)
}

/// Every device signs in with the new name from the next request on.
#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_rename_opds_user(
    service: tauri::State<'_, OpdsService>,
    account: tauri::State<'_, LocalAccount>,
    username: String,
) -> Result<OpdsDeviceKeys, OpdsStatusError> {
    account.rename(&username).map_err(unexpected)?;
    sync_credentials(&service, &account)?;
    account.device_keys().map_err(unexpected)
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_start_opds(
    service: tauri::State<'_, OpdsService>,
    config: OpdsStartConfig,
) -> Result<OpdsServiceStatus, OpdsStatusError> {
    service.start(config).await
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_stop_opds(
    service: tauri::State<'_, OpdsService>,
) -> Result<OpdsServiceStatus, OpdsStatusError> {
    Ok(service.stop().await)
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_reconfigure_opds(
    service: tauri::State<'_, OpdsService>,
    config: OpdsStartConfig,
) -> Result<OpdsServiceStatus, OpdsStatusError> {
    service.reconfigure(config).await
}

#[tauri::command]
#[specta::specta]
pub async fn clb_query_opds_status(
    service: tauri::State<'_, OpdsService>,
) -> Result<OpdsServiceStatus, OpdsStatusError> {
    Ok(service.status().await)
}
