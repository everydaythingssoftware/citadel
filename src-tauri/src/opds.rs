use citadel_opds::{
    credential_store::{OpdsCredentialSecret, OpdsCredentialStatus},
    password::{generate_password, GeneratedOpdsCredentials},
    service::{OpdsErrorCode, OpdsServiceStatus, OpdsStartConfig, OpdsStatusError},
    OpdsService,
};

use crate::account::LocalAccount;

fn unexpected(message: String) -> OpdsStatusError {
    OpdsStatusError {
        code: OpdsErrorCode::Unexpected,
        message,
    }
}

/// The local user's app password is the only credential desktop sharing serves.
pub fn sync_credentials(
    service: &OpdsService,
    account: &LocalAccount,
) -> Result<(), OpdsStatusError> {
    let credentials = account.opds_credentials().map_err(unexpected)?;
    service.replace_credentials(credentials.into_iter().collect())
}

#[tauri::command]
#[specta::specta]
pub async fn clb_query_opds_credential_status(
    account: tauri::State<'_, LocalAccount>,
) -> Result<OpdsCredentialStatus, OpdsStatusError> {
    account.opds_status().map_err(unexpected)
}

#[tauri::command]
#[specta::specta]
pub async fn clb_query_opds_credential_secret(
    account: tauri::State<'_, LocalAccount>,
) -> Result<Option<OpdsCredentialSecret>, OpdsStatusError> {
    account.opds_credentials().map_err(unexpected)
}

/// Stores the credentials and hot-swaps them into a running share.
#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_configure_opds_credentials(
    service: tauri::State<'_, OpdsService>,
    account: tauri::State<'_, LocalAccount>,
    username: String,
    password: String,
) -> Result<OpdsCredentialStatus, OpdsStatusError> {
    account
        .configure(&username, &password)
        .map_err(unexpected)?;
    sync_credentials(&service, &account)?;
    account.opds_status().map_err(unexpected)
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_generate_opds_credentials(
    service: tauri::State<'_, OpdsService>,
    account: tauri::State<'_, LocalAccount>,
    username: String,
) -> Result<GeneratedOpdsCredentials, OpdsStatusError> {
    let password = generate_password();
    account
        .configure(&username, &password)
        .map_err(unexpected)?;
    sync_credentials(&service, &account)?;
    let username = account.user().map_err(unexpected)?.username;
    Ok(GeneratedOpdsCredentials { username, password })
}

/// Clearing stops a running share that requires sign-in (see
/// `OpdsService::clear_credentials`).
#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_clear_opds_credentials(
    service: tauri::State<'_, OpdsService>,
    account: tauri::State<'_, LocalAccount>,
) -> Result<OpdsCredentialStatus, OpdsStatusError> {
    account.clear().map_err(unexpected)?;
    service.clear_credentials().await?;
    account.opds_status().map_err(unexpected)
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
