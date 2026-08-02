use super::{
    GeneratedOpdsCredentials, OpdsCredentialStatus, OpdsNetworkInterface, OpdsService,
    OpdsServiceStatus, OpdsStartConfig, OpdsStatusError,
};

#[tauri::command]
#[specta::specta]
pub fn clb_query_opds_credential_status(
    service: tauri::State<'_, OpdsService>,
) -> Result<OpdsCredentialStatus, OpdsStatusError> {
    Ok(service.credential_status())
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_configure_opds_credentials(
    service: tauri::State<'_, OpdsService>,
    username: String,
    password: String,
) -> Result<OpdsCredentialStatus, OpdsStatusError> {
    service.configure_credentials(username, password).await
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_generate_opds_credentials(
    service: tauri::State<'_, OpdsService>,
    username: String,
) -> Result<GeneratedOpdsCredentials, OpdsStatusError> {
    service.generate_credentials(username).await
}

#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_clear_opds_credentials(
    service: tauri::State<'_, OpdsService>,
) -> Result<OpdsCredentialStatus, OpdsStatusError> {
    service.clear_credentials().await
}

#[tauri::command]
#[specta::specta]
pub async fn clb_query_opds_interfaces(
    service: tauri::State<'_, OpdsService>,
) -> Result<Vec<OpdsNetworkInterface>, OpdsStatusError> {
    service.list_interfaces().await
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
pub async fn clb_query_opds_status(
    service: tauri::State<'_, OpdsService>,
) -> Result<OpdsServiceStatus, OpdsStatusError> {
    Ok(service.status().await)
}
