use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use crate::error::MetadataError;
use crate::http::{self, Http};
use crate::model::{
    normalize_genre_candidates, pick_preferred_isbn, BookMetadata, GenreCandidate, MetadataProvider,
};

// ---------------------------------------------------------------------------
// Private GraphQL response types (serde deserialization)
// ---------------------------------------------------------------------------

/// Hardcover returns IDs as either strings or integers.
struct FlexibleId(Option<i32>);

impl<'de> Deserialize<'de> for FlexibleId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let id = match &value {
            serde_json::Value::String(s) => s.parse::<i32>().ok(),
            serde_json::Value::Number(n) => n.as_i64().map(|n| n as i32),
            _ => None,
        };
        Ok(FlexibleId(id))
    }
}

/// Hardcover returns images as either a string URL or `{"url": "..."}`.
struct FlexibleImage(Option<String>);

impl<'de> Deserialize<'de> for FlexibleImage {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let url = match &value {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Object(obj) => {
                obj.get("url").and_then(|u| u.as_str()).map(String::from)
            }
            serde_json::Value::Array(items) => items.iter().find_map(|item| {
                item.as_object()
                    .and_then(|obj| obj.get("url"))
                    .and_then(|u| u.as_str())
                    .map(String::from)
            }),
            _ => None,
        };
        Ok(FlexibleImage(url))
    }
}

#[derive(Deserialize)]
struct GqlAuthor {
    name: String,
}

#[derive(Deserialize)]
struct GqlContribution {
    author: GqlAuthor,
}

#[derive(Deserialize)]
struct GqlBookDocument {
    id: FlexibleId,
    title: Option<String>,
    description: Option<String>,
    image: Option<FlexibleImage>,
    #[serde(default)]
    isbns: Vec<String>,
    release_year: Option<i32>,
    slug: Option<String>,
    #[serde(default)]
    contributions: Vec<GqlContribution>,
    #[serde(default)]
    genres: Vec<String>,
}

#[derive(Deserialize)]
struct GqlSearchHit {
    document: GqlBookDocument,
}

#[derive(Deserialize)]
struct GqlSearchResults {
    hits: Vec<GqlSearchHit>,
}

#[derive(Deserialize)]
struct GqlSearchData {
    #[allow(dead_code)]
    ids: Vec<serde_json::Value>,
    results: GqlSearchResults,
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

pub const API_URL: &str = "https://api.hardcover.app/v1/graphql";
const TIMEOUT: Duration = Duration::from_secs(10);

/// Normalize an API key into a Bearer authorization header value.
fn make_auth_header(api_key: &str) -> String {
    if api_key.starts_with("Bearer ") {
        api_key.to_string()
    } else {
        format!("Bearer {}", api_key)
    }
}

/// POST a GraphQL query with the user's key, check for GraphQL errors, and
/// return the `data` field.
async fn execute_graphql(
    http: &Http,
    api_url: &str,
    api_key: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, MetadataError> {
    let response = http::send(
        http.post(api_url, TIMEOUT)
            .header("authorization", make_auth_header(api_key))
            .json(&body),
    )
    .await
    .map_err(|error| match error.kind {
        crate::MetadataErrorKind::Upstream => {
            MetadataError::upstream(format!("Hardcover: {}", error.message))
        }
        _ => error,
    })?;

    let body = response
        .text()
        .await
        .map_err(|e| MetadataError::upstream(format!("Failed to read response: {}", e)))?;
    log::debug!("Hardcover API: body_len={}", body.len());

    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| MetadataError::upstream(format!("Failed to parse response: {}", e)))?;

    if let Some(error) = json
        .get("errors")
        .and_then(|errors| errors.as_array())
        .and_then(|errors| errors.first())
    {
        let message = error
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("Unknown error");
        let code = error
            .pointer("/extensions/code")
            .and_then(|code| code.as_str())
            .unwrap_or_default();
        log::warn!("Hardcover GraphQL error: {} ({})", message, code);
        return Err(if is_credential_error(code, message) {
            MetadataError::unauthorized("Hardcover rejected the API key — check it in settings.")
        } else {
            MetadataError::upstream(format!("API error: {}", message))
        });
    }

    json.get("data")
        .cloned()
        .ok_or_else(|| MetadataError::upstream("No data in GraphQL response"))
}

/// Hasura reports a bad or expired token as a GraphQL error, not a 401.
fn is_credential_error(code: &str, message: &str) -> bool {
    matches!(code, "invalid-jwt" | "invalid-headers" | "access-denied")
        || message.to_ascii_lowercase().contains("jwt")
        || message.contains("Authorization")
}

fn parse_search_data(data: &serde_json::Value) -> Result<GqlSearchData, MetadataError> {
    let search = data
        .get("search")
        .ok_or_else(|| MetadataError::upstream("No search data in response"))?;
    serde_json::from_value(search.clone())
        .map_err(|e| MetadataError::upstream(format!("Failed to parse search results: {}", e)))
}

fn document_to_metadata(doc: GqlBookDocument) -> BookMetadata {
    BookMetadata {
        provider: MetadataProvider::Hardcover,
        provider_id: doc.id.0.map(|id| id.to_string()).unwrap_or_default(),
        identifier_label: MetadataProvider::Hardcover.identifier_label().to_string(),
        title: doc.title.unwrap_or_default(),
        subtitle: None,
        authors: doc
            .contributions
            .into_iter()
            .map(|c| c.author.name)
            .collect(),
        isbn: pick_preferred_isbn(&doc.isbns),
        release_year: doc.release_year,
        description: doc.description,
        image_url: doc.image.and_then(|i| i.0),
        cover_id: None,
        publisher: None,
        subjects: Vec::new(),
        genre_candidates: normalize_genre_candidates(doc.genres.into_iter().map(|name| {
            GenreCandidate {
                name,
                source: "hardcover:genre".to_string(),
                vocabulary: Some("hardcover".to_string()),
            }
        })),
        language_code: None,
        slug: doc.slug,
    }
}

async fn run_search(
    http: &Http,
    api_url: &str,
    api_key: &str,
    query: &str,
) -> Result<Vec<BookMetadata>, MetadataError> {
    let graphql_query = r#"
        query SearchBooks($query: String!) {
            search(query: $query, query_type: BOOK) { ids results }
        }
    "#;

    let data = execute_graphql(
        http,
        api_url,
        api_key,
        json!({ "query": graphql_query, "variables": { "query": query } }),
    )
    .await?;
    let search = parse_search_data(&data)?;

    Ok(search
        .results
        .hits
        .into_iter()
        .map(|hit| document_to_metadata(hit.document))
        .collect())
}

// ---------------------------------------------------------------------------
// Provider entry points
// ---------------------------------------------------------------------------

pub async fn search(
    http: &Http,
    api_url: &str,
    api_key: &str,
    query: &str,
) -> Result<Vec<BookMetadata>, MetadataError> {
    run_search(http, api_url, api_key, query).await
}

pub async fn search_by_isbn(
    http: &Http,
    api_url: &str,
    api_key: &str,
    isbn: &str,
) -> Result<Vec<BookMetadata>, MetadataError> {
    run_search(http, api_url, api_key, isbn).await
}

/// Validate an API key by querying the authenticated `me` field. Returns the
/// account's username when Hardcover reports one.
pub async fn test(
    http: &Http,
    api_url: &str,
    api_key: &str,
) -> Result<Option<String>, MetadataError> {
    let query = r#"query { me { id username } }"#;
    let data = execute_graphql(http, api_url, api_key, json!({ "query": query })).await?;
    parse_me(&data)
}

/// `me` is a one-row list in Hardcover's Hasura schema; accept an object too.
fn parse_me(data: &serde_json::Value) -> Result<Option<String>, MetadataError> {
    let me = data
        .get("me")
        .ok_or_else(|| MetadataError::upstream("Invalid API response format"))?;
    let account = match me {
        serde_json::Value::Array(rows) => rows.first(),
        serde_json::Value::Object(_) => Some(me),
        _ => None,
    }
    .ok_or_else(|| {
        MetadataError::unauthorized("Hardcover rejected the API key — check it in settings.")
    })?;
    Ok(account
        .get("username")
        .and_then(|username| username.as_str())
        .map(String::from))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_fixture_maps_to_metadata() {
        let data: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/hardcover_search_dune.json"))
                .unwrap();
        let search = parse_search_data(&data["data"]).unwrap();
        let books: Vec<_> = search
            .results
            .hits
            .into_iter()
            .map(|hit| document_to_metadata(hit.document))
            .collect();
        assert_eq!(books.len(), 2);
        let dune = &books[0];
        assert_eq!(dune.provider_id, "312460");
        assert_eq!(dune.title, "Dune");
        assert_eq!(dune.authors, ["Frank Herbert"]);
        assert_eq!(dune.isbn.as_deref(), Some("9780441172719"));
        assert_eq!(dune.release_year, Some(1965));
        assert_eq!(dune.slug.as_deref(), Some("dune"));
        assert_eq!(
            dune.image_url.as_deref(),
            Some("https://assets.hardcover.app/edition/30405274/d41d8cd98f00b204e9800998ecf8427e.jpeg")
        );
        assert_eq!(books[1].image_url, None);
    }

    #[test]
    fn me_reports_the_account_or_rejects_an_empty_list() {
        assert_eq!(
            parse_me(&serde_json::json!({"me": [{"id": 1, "username": "reader"}]})).unwrap(),
            Some("reader".to_string())
        );
        assert_eq!(
            parse_me(&serde_json::json!({"me": {"id": 1, "username": "reader"}})).unwrap(),
            Some("reader".to_string())
        );
        assert_eq!(
            parse_me(&serde_json::json!({"me": []})).unwrap_err().kind,
            crate::MetadataErrorKind::Unauthorized
        );
    }

    #[test]
    fn hasura_token_errors_are_credential_errors() {
        assert!(is_credential_error("invalid-jwt", "Could not verify JWT"));
        assert!(is_credential_error("", "Malformed Authorization header"));
        assert!(!is_credential_error("validation-failed", "field not found"));
    }

    #[test]
    fn search_document_genres_are_normalized_with_provenance() {
        let document: GqlBookDocument = serde_json::from_value(serde_json::json!({
            "id": 42,
            "title": "Book",
            "genres": [" Science   Fiction ", "science fiction", "Fantasy"]
        }))
        .unwrap();
        let metadata = document_to_metadata(document);
        let names: Vec<_> = metadata
            .genre_candidates
            .iter()
            .map(|genre| genre.name.as_str())
            .collect();
        assert_eq!(names, ["Science Fiction", "Fantasy"]);
        assert!(metadata
            .genre_candidates
            .iter()
            .all(|genre| genre.source == "hardcover:genre"));
    }
}
