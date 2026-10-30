use std::time::Duration;

use crate::error::MetadataError;
use crate::http::Http;
use crate::model::{isbn_equivalent, BookMetadata};
use crate::providers::marcxml;
use crate::providers::source::SruEndpoint;

/// Search an SRU endpoint. When `isbn` is given the CQL targets the endpoint's
/// ISBN index and the results are filtered to records whose `020$a` actually
/// matches (SRU matching is fuzzy); otherwise it is a quoted title/keyword
/// search.
pub async fn search(
    http: &Http,
    base_url: &str,
    ep: &SruEndpoint,
    query: &str,
    isbn: Option<&str>,
) -> Result<Vec<BookMetadata>, MetadataError> {
    let cql = match isbn {
        Some(i) => format!("{}={}", ep.isbn_index, i),
        None => format!("{}=\"{}\"", ep.title_index, query),
    };

    let url = format!(
        "{base}?version={version}&operation=searchRetrieve&query={query}&recordSchema={schema}&maximumRecords={max}",
        base = base_url,
        version = ep.version,
        query = urlencoding::encode(&cql),
        schema = ep.record_schema,
        max = ep.max_records,
    );

    let body = http
        .get_text(&url, Duration::from_millis(ep.timeout_ms))
        .await?;
    let mut records =
        marcxml::parse_envelope(&body, ep.provider).map_err(MetadataError::upstream)?;

    if let Some(want) = isbn {
        records.retain(|record| {
            record
                .isbn
                .as_deref()
                .is_some_and(|got| isbn_equivalent(got, want))
        });
    }

    Ok(records)
}
