use std::collections::HashMap;

use serde::Deserialize;

use crate::metadata::http;
use crate::metadata::model::{normalize_isbn, BookMetadata, MetadataProvider};

const TIMEOUT_MS: u64 = 8_000;
const MAX_SUBJECTS: usize = 30;

// ---------------------------------------------------------------------------
// `jscmd=data` (by-ISBN) response
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct OlNamed {
    name: String,
}

#[derive(Deserialize)]
struct OlCover {
    small: Option<String>,
    medium: Option<String>,
    large: Option<String>,
}

#[derive(Deserialize, Default)]
struct OlIdentifiers {
    #[serde(default)]
    openlibrary: Vec<String>,
    #[serde(default)]
    isbn_13: Vec<String>,
    #[serde(default)]
    isbn_10: Vec<String>,
}

#[derive(Deserialize)]
struct OlDataBook {
    title: Option<String>,
    subtitle: Option<String>,
    #[serde(default)]
    authors: Vec<OlNamed>,
    #[serde(default)]
    publishers: Vec<OlNamed>,
    publish_date: Option<String>,
    #[serde(default)]
    subjects: Vec<OlNamed>,
    identifiers: Option<OlIdentifiers>,
    cover: Option<OlCover>,
    key: Option<String>,
}

// ---------------------------------------------------------------------------
// `search.json` (free-text) response
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct OlSearchResponse {
    #[serde(default)]
    docs: Vec<OlSearchDoc>,
}

#[derive(Deserialize)]
struct OlSearchDoc {
    key: Option<String>,
    title: Option<String>,
    subtitle: Option<String>,
    #[serde(default)]
    author_name: Vec<String>,
    first_publish_year: Option<i32>,
    #[serde(default)]
    isbn: Vec<String>,
    cover_i: Option<i64>,
    #[serde(default)]
    edition_key: Vec<String>,
    #[serde(default)]
    publisher: Vec<String>,
    #[serde(default)]
    subject: Vec<String>,
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

pub async fn search_by_isbn(isbn: &str) -> Result<Vec<BookMetadata>, String> {
    let url = format!(
        "https://openlibrary.org/api/books?bibkeys=ISBN:{}&format=json&jscmd=data",
        urlencoding::encode(isbn)
    );
    let response: HashMap<String, OlDataBook> = http::get_json(&url, TIMEOUT_MS).await?;
    Ok(response
        .into_values()
        .next()
        .map(|book| vec![map_data_book(book, isbn)])
        .unwrap_or_default())
}

pub async fn search(query: &str) -> Result<Vec<BookMetadata>, String> {
    let url = format!(
        "https://openlibrary.org/search.json?q={}&limit=5&fields=key,title,subtitle,author_name,first_publish_year,isbn,cover_i,edition_key,publisher,subject",
        urlencoding::encode(query)
    );
    let response: OlSearchResponse = http::get_json(&url, TIMEOUT_MS).await?;
    Ok(response.docs.into_iter().map(map_search_doc).collect())
}

/// Lightweight reachability check used by the settings "Test" button.
pub async fn test() -> Result<(), String> {
    let url = "https://openlibrary.org/search.json?q=test&limit=0";
    http::get_text(url, TIMEOUT_MS).await.map(|_| ())
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

fn map_data_book(book: OlDataBook, queried_isbn: &str) -> BookMetadata {
    let identifiers = book.identifiers.unwrap_or_default();
    let provider_id = identifiers
        .openlibrary
        .into_iter()
        .next()
        .or_else(|| book.key.as_deref().map(strip_olid))
        .unwrap_or_default();

    let isbn = identifiers
        .isbn_13
        .iter()
        .chain(identifiers.isbn_10.iter())
        .find_map(|i| normalize_isbn(i))
        .or_else(|| normalize_isbn(queried_isbn));

    let image_url = book.cover.and_then(|c| c.large.or(c.medium).or(c.small));

    BookMetadata {
        provider: MetadataProvider::OpenLibrary,
        provider_id,
        identifier_label: MetadataProvider::OpenLibrary.identifier_label().to_string(),
        title: book.title.unwrap_or_default(),
        subtitle: book.subtitle.filter(|s| !s.is_empty()),
        authors: book.authors.into_iter().map(|a| a.name).collect(),
        isbn,
        release_year: book.publish_date.as_deref().and_then(extract_year),
        description: None,
        image_url,
        publisher: book.publishers.into_iter().next().map(|p| p.name),
        subjects: dedupe_subjects(book.subjects.into_iter().map(|s| s.name)),
        genre_candidates: Vec::new(),
        language_code: None,
        slug: None,
    }
}

fn map_search_doc(doc: OlSearchDoc) -> BookMetadata {
    let provider_id = doc
        .edition_key
        .into_iter()
        .next()
        .or_else(|| doc.key.as_deref().map(strip_olid))
        .unwrap_or_default();

    let image_url = doc
        .cover_i
        .map(|id| format!("https://covers.openlibrary.org/b/id/{id}-M.jpg"));

    BookMetadata {
        provider: MetadataProvider::OpenLibrary,
        provider_id,
        identifier_label: MetadataProvider::OpenLibrary.identifier_label().to_string(),
        title: doc.title.unwrap_or_default(),
        subtitle: doc.subtitle.filter(|s| !s.is_empty()),
        authors: doc.author_name,
        isbn: doc.isbn.iter().find_map(|i| normalize_isbn(i)),
        release_year: doc.first_publish_year,
        description: None,
        image_url,
        publisher: doc.publisher.into_iter().next(),
        subjects: dedupe_subjects(doc.subject.into_iter()),
        genre_candidates: Vec::new(),
        language_code: None,
        slug: None,
    }
}

fn strip_olid(key: &str) -> String {
    key.rsplit('/').next().unwrap_or(key).to_string()
}

fn extract_year(s: &str) -> Option<i32> {
    let bytes = s.as_bytes();
    bytes.windows(4).find_map(|w| {
        if w.iter().all(|b| b.is_ascii_digit()) {
            std::str::from_utf8(w).ok()?.parse::<i32>().ok()
        } else {
            None
        }
    })
}

fn dedupe_subjects(subjects: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for subject in subjects {
        let trimmed = subject.trim().to_string();
        if !trimmed.is_empty() && !out.iter().any(|s| s.eq_ignore_ascii_case(&trimmed)) {
            out.push(trimmed);
            if out.len() >= MAX_SUBJECTS {
                break;
            }
        }
    }
    out
}
