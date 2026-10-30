use std::str::FromStr;

use citadel_metadata::{BookMetadata, MetadataClient, MetadataProvider, ProviderStatus};
use tauri::State;

/// Test that a provider is reachable / its credentials are valid.
#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_test_metadata_provider(
    client: State<'_, MetadataClient>,
    provider: String,
    api_key: String,
) -> Result<ProviderStatus, String> {
    let provider = MetadataProvider::from_str(&provider)?;

    Ok(match client.test(provider, Some(&api_key)).await {
        Ok(_) => ProviderStatus {
            provider,
            is_valid: true,
            message: "Connection successful".to_string(),
        },
        Err(error) => ProviderStatus {
            provider,
            is_valid: false,
            message: error.message,
        },
    })
}

/// Free-text search a provider. A clean "no results" is `Ok(vec![])`, not an error.
#[tauri::command]
#[specta::specta]
pub async fn clb_query_metadata_search(
    client: State<'_, MetadataClient>,
    provider: String,
    query: String,
    api_key: String,
) -> Result<Vec<BookMetadata>, String> {
    let provider = MetadataProvider::from_str(&provider)?;
    Ok(client.search(provider, &query, Some(&api_key)).await?)
}

/// Look a provider up by ISBN. A clean "no match" is `Ok(vec![])`, not an error.
#[tauri::command]
#[specta::specta]
pub async fn clb_query_metadata_by_isbn(
    client: State<'_, MetadataClient>,
    provider: String,
    isbn: String,
    api_key: String,
) -> Result<Vec<BookMetadata>, String> {
    let provider = MetadataProvider::from_str(&provider)?;
    Ok(client.by_isbn(provider, &isbn, Some(&api_key)).await?)
}
