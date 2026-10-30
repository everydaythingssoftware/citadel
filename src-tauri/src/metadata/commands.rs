use std::str::FromStr;

use crate::metadata::model::{BookMetadata, MetadataProvider, ProviderStatus};
use crate::metadata::{hardcover, openlibrary, source, sru};

/// Test that a provider is reachable / its credentials are valid.
#[tauri::command]
#[specta::specta]
pub async fn clb_cmd_test_metadata_provider(
    provider: String,
    api_key: String,
) -> Result<ProviderStatus, String> {
    let provider = MetadataProvider::from_str(&provider)?;

    let result = match provider {
        MetadataProvider::Hardcover => hardcover::test(api_key.trim()).await,
        MetadataProvider::Loc
        | MetadataProvider::Dnb
        | MetadataProvider::K10plus
        | MetadataProvider::Bnf => {
            let endpoint = source::endpoint(provider).ok_or("Provider not available")?;
            sru::search(endpoint, "test", None).await.map(|_| ())
        }
        MetadataProvider::OpenLibrary => openlibrary::test().await,
    };

    Ok(match result {
        Ok(()) => ProviderStatus {
            provider,
            is_valid: true,
            message: "Connection successful".to_string(),
        },
        Err(message) => ProviderStatus {
            provider,
            is_valid: false,
            message,
        },
    })
}

/// Free-text search a provider. A clean "no results" is `Ok(vec![])`, not an error.
#[tauri::command]
#[specta::specta]
pub async fn clb_query_metadata_search(
    provider: String,
    query: String,
    api_key: String,
) -> Result<Vec<BookMetadata>, String> {
    let provider = MetadataProvider::from_str(&provider)?;
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    match provider {
        MetadataProvider::Hardcover => {
            let key = require_key(&api_key)?;
            hardcover::search(key, query).await
        }
        MetadataProvider::Loc
        | MetadataProvider::Dnb
        | MetadataProvider::K10plus
        | MetadataProvider::Bnf => {
            let endpoint = source::endpoint(provider).ok_or("Provider not available")?;
            sru::search(endpoint, query, None).await
        }
        MetadataProvider::OpenLibrary => openlibrary::search(query).await,
    }
}

/// Look a provider up by ISBN. A clean "no match" is `Ok(vec![])`, not an error.
#[tauri::command]
#[specta::specta]
pub async fn clb_query_metadata_by_isbn(
    provider: String,
    isbn: String,
    api_key: String,
) -> Result<Vec<BookMetadata>, String> {
    let provider = MetadataProvider::from_str(&provider)?;
    let isbn = isbn.trim();
    if isbn.is_empty() {
        return Err("ISBN is empty".to_string());
    }

    match provider {
        MetadataProvider::Hardcover => {
            let key = require_key(&api_key)?;
            hardcover::search_by_isbn(key, isbn).await
        }
        MetadataProvider::Loc
        | MetadataProvider::Dnb
        | MetadataProvider::K10plus
        | MetadataProvider::Bnf => {
            let endpoint = source::endpoint(provider).ok_or("Provider not available")?;
            sru::search(endpoint, "", Some(isbn)).await
        }
        MetadataProvider::OpenLibrary => openlibrary::search_by_isbn(isbn).await,
    }
}

fn require_key(api_key: &str) -> Result<&str, String> {
    let key = api_key.trim();
    if key.is_empty() {
        Err("API key is empty".to_string())
    } else {
        Ok(key)
    }
}
