use citadel_core::store::NewDeviceKey;
use citadel_opds::{
    service::{OpdsErrorCode, OpdsServiceStatus, OpdsStartConfig, OpdsStatusError},
    OpdsService,
};

use crate::account::{LocalAccount, OpdsDeviceKeys};

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

/// Revoking the last key stops a running share that requires sign-in (see
/// `OpdsService::clear_credentials`).
#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_revoke_opds_device_key(
    service: tauri::State<'_, OpdsService>,
    account: tauri::State<'_, LocalAccount>,
    key_id: String,
) -> Result<OpdsDeviceKeys, OpdsStatusError> {
    account.revoke_device_key(&key_id).map_err(unexpected)?;
    let keys = account.device_keys().map_err(unexpected)?;
    if keys.keys.is_empty() {
        service.clear_credentials().await?;
    } else {
        sync_credentials(&service, &account)?;
    }
    Ok(keys)
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
