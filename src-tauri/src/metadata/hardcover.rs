use serde::Deserialize;
use serde_json::json;

use crate::metadata::model::{
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

const HARDCOVER_API_URL: &str = "https://api.hardcover.app/v1/graphql";

/// Normalize an API key into a Bearer authorization header value.
fn make_auth_header(api_key: &str) -> String {
    if api_key.starts_with("Bearer ") {
        api_key.to_string()
    } else {
        format!("Bearer {}", api_key)
    }
}

fn hardcover_request(api_key: &str) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .post(HARDCOVER_API_URL)
        .header("authorization", make_auth_header(api_key))
        .header("content-type", "application/json")
}

/// Read a GraphQL response: check HTTP status, parse JSON, check for GraphQL
/// errors, and return the `data` field.
async fn execute_graphql(response: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    log::debug!("Hardcover API: status={}, body_len={}", status, body.len());

    if !status.is_success() {
        return Err(format!("Hardcover API returned status {}", status));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(errors) = json.get("errors") {
        let message = errors
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("Unknown error");
        log::warn!("Hardcover GraphQL error: {}", message);
        return Err(format!("API error: {}", message));
    }

    json.get("data")
        .cloned()
        .ok_or_else(|| "No data in GraphQL response".to_string())
}

fn parse_search_data(data: &serde_json::Value) -> Result<GqlSearchData, String> {
    let search = data.get("search").ok_or("No search data in response")?;
    serde_json::from_value(search.clone())
        .map_err(|e| format!("Failed to parse search results: {}", e))
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

async fn run_search(api_key: &str, query: &str) -> Result<Vec<BookMetadata>, String> {
    let graphql_query = r#"
        query SearchBooks($query: String!) {
            search(query: $query, query_type: BOOK) { ids results }
        }
    "#;

    let response = hardcover_request(api_key)
        .json(&json!({ "query": graphql_query, "variables": { "query": query } }))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Hardcover API: {}", e))?;

    let data = execute_graphql(response).await?;
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

pub async fn search(api_key: &str, query: &str) -> Result<Vec<BookMetadata>, String> {
    run_search(api_key, query).await
}

pub async fn search_by_isbn(api_key: &str, isbn: &str) -> Result<Vec<BookMetadata>, String> {
    run_search(api_key, isbn).await
}

/// Validate an API key by querying the authenticated `me` field.
pub async fn test(api_key: &str) -> Result<(), String> {
    let query = r#"query { me { id username } }"#;

    let response = hardcover_request(api_key)
        .json(&json!({ "query": query }))
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Hardcover API: {}", e))?;

    let data = execute_graphql(response).await?;
    if data.get("me").is_some() {
        Ok(())
    } else {
        Err("Invalid API response format".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
