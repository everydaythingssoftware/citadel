use super::{
    network::OpdsNetworkInterface,
    service::{OpdsServiceStatus, OpdsStartConfig, OpdsStatusError},
    OpdsService,
};

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
