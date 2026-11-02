//! A signed-in user's own settings, starting with their keys for metadata
//! providers such as Hardcover. Keys are checked with the provider, sealed
//! with the server's vault (ADR 0011) and never sent back to the browser.
use axum::{
    extract::{rejection::JsonRejection, Extension, Path, State},
    http::StatusCode,
    Json,
};
use citadel_core::{error::LibraryError, store::ProviderCredential};
use citadel_metadata::MetadataProvider;
use serde::{Deserialize, Serialize};

use super::{
    metadata::MetadataFailure,
    session::{blocking, SignedIn},
    ApiState,
};

const MAX_SECRET_CHARS: usize = 4096;

#[derive(Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProviderCredentialInfo {
    provider: MetadataProvider,
    display_name: String,
    /// The provider account the key belongs to, when the provider says.
    #[schema(required = true)]
    account_name: Option<String>,
    /// When the key was saved, in Unix seconds.
    created_at: i64,
    /// When the provider last accepted the key, in Unix seconds.
    #[schema(required = true)]
    verified_at: Option<i64>,
    /// The server can no longer read the key (its vault key changed); enter
    /// it again.
    needs_reentry: bool,
}

impl ProviderCredentialInfo {
    fn from_stored(credential: ProviderCredential) -> Option<Self> {
        let provider = credential.provider.parse::<MetadataProvider>().ok()?;
        Some(Self {
            provider,
            display_name: provider.display_name().into(),
            account_name: credential.label,
            created_at: credential.created_at,
            verified_at: credential.verified_at,
            needs_reentry: credential.needs_reentry,
        })
    }
}

#[derive(Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SaveProviderCredential {
    /// The provider API key. It is checked with the provider before saving.
    secret: String,
}

fn keyed(provider: MetadataProvider) -> Result<(), MetadataFailure> {
    if provider.requires_key() {
        Ok(())
    } else {
        Err(LibraryError::invalid(format!(
            "{} doesn't use an API key",
            provider.display_name()
        ))
        .into())
    }
}

/// Hardcover shows keys with their `Bearer ` prefix; accept either form.
fn normalize_secret(secret: &str) -> Result<String, MetadataFailure> {
    let secret = secret.trim();
    let secret = match secret.split_once(char::is_whitespace) {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("bearer") => rest.trim(),
        _ if secret.eq_ignore_ascii_case("bearer") => "",
        _ => secret,
    };
    if secret.is_empty() {
        return Err(LibraryError::invalid("Enter an API key").into());
    }
    if secret.chars().count() > MAX_SECRET_CHARS || secret.chars().any(char::is_control) {
        return Err(LibraryError::invalid("That doesn't look like an API key").into());
    }
    Ok(secret.to_string())
}

#[utoipa::path(get, path = "/api/account/provider-credentials", operation_id = "listProviderCredentials",
    description = "The signed-in user's saved provider keys. Keys themselves are never returned.",
    responses((status = 200, body = Vec<ProviderCredentialInfo>), (status = 401, body = LibraryError),
        (status = 503, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn list(
    State(state): State<ApiState>,
    Extension(SignedIn(user)): Extension<SignedIn>,
) -> Result<Json<Vec<ProviderCredentialInfo>>, MetadataFailure> {
    let vault = state.secrets.clone();
    let stored = blocking(&state, move |accounts| {
        accounts.provider_credentials(&vault, &user.id)
    })
    .await?;
    Ok(Json(
        stored
            .into_iter()
            .filter_map(ProviderCredentialInfo::from_stored)
            .collect(),
    ))
}

#[utoipa::path(put, path = "/api/account/provider-credentials/{provider}", operation_id = "saveProviderCredential",
    params(("provider" = MetadataProvider, Path, description = "A provider that needs a key")),
    request_body = SaveProviderCredential,
    description = "Check a provider key with the provider, then save it for the signed-in user, replacing any earlier key.",
    responses((status = 200, body = ProviderCredentialInfo), (status = 400, body = LibraryError),
        (status = 401, body = LibraryError), (status = 429, body = LibraryError), (status = 503, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn save(
    State(state): State<ApiState>,
    Extension(user): Extension<SignedIn>,
    Path(provider): Path<MetadataProvider>,
    request: Result<Json<SaveProviderCredential>, JsonRejection>,
) -> Result<Json<ProviderCredentialInfo>, MetadataFailure> {
    keyed(provider)?;
    let Json(request) =
        request.map_err(|_| LibraryError::invalid("Invalid provider credential JSON"))?;
    let secret = normalize_secret(&request.secret)?;
    let account_name = state.metadata.verify(&user, provider, &secret).await?;
    let vault = state.secrets.clone();
    let user_id = user.0.id.clone();
    let saved = blocking(&state, move |accounts| {
        accounts.save_provider_credential(
            &vault,
            &user_id,
            provider.id(),
            &secret,
            account_name.as_deref(),
        )
    })
    .await?;
    ProviderCredentialInfo::from_stored(saved)
        .map(Json)
        .ok_or_else(|| LibraryError::unavailable().into())
}

#[utoipa::path(delete, path = "/api/account/provider-credentials/{provider}", operation_id = "deleteProviderCredential",
    params(("provider" = MetadataProvider, Path, description = "Provider ID")),
    description = "Forget the signed-in user's key for a provider.",
    responses((status = 204), (status = 401, body = LibraryError), (status = 404, body = LibraryError),
        (status = 503, body = LibraryError)),
    security(("session" = [])))]
pub(super) async fn delete(
    State(state): State<ApiState>,
    Extension(SignedIn(user)): Extension<SignedIn>,
    Path(provider): Path<MetadataProvider>,
) -> Result<StatusCode, MetadataFailure> {
    let deleted = blocking(&state, move |accounts| {
        accounts.delete_provider_credential(&user.id, provider.id())
    })
    .await?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(LibraryError::new(
            citadel_core::error::LibraryErrorCode::NotFound,
            format!("No {} key is saved", provider.display_name()),
        )
        .into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_trimmed_and_bearer_prefixes_dropped() {
        assert_eq!(normalize_secret("  abc ").ok().unwrap(), "abc");
        assert_eq!(normalize_secret("Bearer abc").ok().unwrap(), "abc");
        assert!(normalize_secret("Bearer ").is_err());
        assert!(normalize_secret("a\nb").is_err());
        assert!(normalize_secret(&"a".repeat(MAX_SECRET_CHARS + 1)).is_err());
    }
}
