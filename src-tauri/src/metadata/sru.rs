use crate::metadata::model::{isbn_equivalent, isbn_search_forms, BookMetadata};
use crate::metadata::source::{RecordFormat, SruEndpoint};
use crate::metadata::{http, marcxml, unimarc};

/// Search an SRU endpoint. When `isbn` is given the CQL targets the endpoint's
/// ISBN index and the results are filtered to records whose ISBN actually
/// matches (SRU matching is fuzzy); otherwise it is a quoted title/keyword
/// search.
pub async fn search(
    ep: &SruEndpoint,
    query: &str,
    isbn: Option<&str>,
) -> Result<Vec<BookMetadata>, String> {
    let mut records = fetch(ep, &build_cql(ep, query, isbn)).await?;

    if let Some(want) = isbn {
        records.retain(|record| keep_for_isbn(ep, record.isbn.as_deref(), want));
    } else if records.is_empty() {
        if let Some(index) = ep.title_fallback_index {
            records = fetch(ep, &title_cql(ep, index, query)).await?;
        }
    }

    Ok(records)
}

async fn fetch(ep: &SruEndpoint, cql: &str) -> Result<Vec<BookMetadata>, String> {
    let url = format!(
        "{base}?version={version}&operation=searchRetrieve&query={query}&recordSchema={schema}&maximumRecords={max}",
        base = ep.base_url,
        version = ep.version,
        query = urlencoding::encode(cql),
        schema = ep.record_schema,
        max = ep.max_records,
    );

    let body = http::get_text(&url, ep.timeout_ms).await?;
    match ep.record_format {
        RecordFormat::Marc21 => marcxml::parse_envelope(&body, ep.provider),
        RecordFormat::Unimarc => unimarc::parse_envelope(&body, ep.provider),
    }
}

fn build_cql(ep: &SruEndpoint, query: &str, isbn: Option<&str>) -> String {
    match isbn {
        Some(want) => {
            let terms = if ep.exact_isbn_index {
                let forms = isbn_search_forms(want);
                if forms.is_empty() {
                    vec![want.to_string()]
                } else {
                    forms
                }
            } else {
                vec![want.to_string()]
            };
            terms
                .iter()
                .map(|term| isbn_clause(ep, term))
                .collect::<Vec<_>>()
                .join(" or ")
        }
        None => title_cql(ep, ep.title_index, query),
    }
}

fn title_cql(ep: &SruEndpoint, index: &str, query: &str) -> String {
    let clause = if ep.title_relation == "=" {
        format!("{index}=\"{query}\"")
    } else {
        format!("{index} {} \"{query}\"", ep.title_relation)
    };
    match ep.title_filter {
        Some(filter) => format!("{clause} and {filter}"),
        None => clause,
    }
}

fn isbn_clause(ep: &SruEndpoint, term: &str) -> String {
    if ep.isbn_relation == "=" {
        format!("{}={}", ep.isbn_index, term)
    } else {
        format!("{} {} \"{}\"", ep.isbn_index, ep.isbn_relation, term)
    }
}

/// An ISBN lookup keeps a record whose ISBN matches. A record with no ISBN at
/// all is kept only for exact-index endpoints, where the index itself already
/// matched it (older BnF records lack an ISBN in UNIMARC); a record carrying a
/// different ISBN is always dropped.
fn keep_for_isbn(ep: &SruEndpoint, got: Option<&str>, want: &str) -> bool {
    match got {
        Some(got) => isbn_equivalent(got, want),
        None => ep.exact_isbn_index,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::model::MetadataProvider;
    use crate::metadata::source::endpoint;

    fn ep(provider: MetadataProvider) -> &'static SruEndpoint {
        endpoint(provider).unwrap()
    }

    #[test]
    fn marc21_endpoints_keep_their_original_cql() {
        assert_eq!(
            build_cql(ep(MetadataProvider::Loc), "", Some("9780553103540")),
            "bath.isbn=9780553103540"
        );
        assert_eq!(
            build_cql(ep(MetadataProvider::Dnb), "dune", None),
            "tit=\"dune\""
        );
        assert_eq!(
            build_cql(ep(MetadataProvider::K10plus), "", Some("0553103547")),
            "pica.isb=0553103547"
        );
    }

    #[test]
    fn bnf_isbn_query_covers_both_forms() {
        assert_eq!(
            build_cql(ep(MetadataProvider::Bnf), "", Some("9782070360024")),
            "bib.isbn adj \"9782070360024\" or bib.isbn adj \"2070360024\""
        );
        assert_eq!(
            build_cql(ep(MetadataProvider::Bnf), "", Some("2070360024")),
            "bib.isbn adj \"9782070360024\" or bib.isbn adj \"2070360024\""
        );
    }

    #[test]
    fn bnf_title_query_is_filtered_to_printed_texts() {
        assert_eq!(
            build_cql(ep(MetadataProvider::Bnf), "petit prince", None),
            "bib.title all \"petit prince\" and bib.doctype any \"a\""
        );
    }

    #[test]
    fn bnf_fallback_query_searches_every_field() {
        let bnf = ep(MetadataProvider::Bnf);
        assert_eq!(
            title_cql(bnf, "bib.anywhere", "le vol du dragon, caffrey, pocket"),
            "bib.anywhere all \"le vol du dragon, caffrey, pocket\" and bib.doctype any \"a\""
        );
        assert!(ep(MetadataProvider::Loc).title_fallback_index.is_none());
    }

    #[test]
    fn isbnless_records_survive_only_on_exact_index_endpoints() {
        let bnf = ep(MetadataProvider::Bnf);
        let loc = ep(MetadataProvider::Loc);
        assert!(keep_for_isbn(bnf, None, "9782070360024"));
        assert!(!keep_for_isbn(loc, None, "9780553103540"));
        assert!(keep_for_isbn(bnf, Some("2070360024"), "9782070360024"));
        assert!(!keep_for_isbn(bnf, Some("9782226257017"), "9782070360024"));
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::metadata::model::MetadataProvider;
    use crate::metadata::source::endpoint;

    #[tokio::test]
    #[ignore = "hits the live BnF catalogue"]
    async fn bnf_finds_records_by_isbn_in_either_form() {
        let bnf = endpoint(MetadataProvider::Bnf).unwrap();
        let potter = search(bnf, "", Some("9782070584628")).await.unwrap();
        assert_eq!(potter[0].series.as_deref(), Some("Harry Potter"));
        let stranger = search(bnf, "", Some("9782070360024")).await.unwrap();
        assert_eq!(stranger[0].title, "L'Étranger");
        let by_title = search(bnf, "sapiens histoire humanité", None)
            .await
            .unwrap();
        assert!(!by_title.is_empty());
        let by_mixed = search(bnf, "Le vol du dragon, caffrey, pocket", None)
            .await
            .unwrap();
        let dragon = by_mixed
            .iter()
            .find(|b| b.provider_id == "cb35022351p")
            .unwrap();
        assert_eq!(dragon.series.as_deref(), Some("La Ballade de Pern"));
        assert_eq!(dragon.series_index, Some(1.0));
        assert_eq!(dragon.collection.as_deref(), Some("Presses pocket 5341"));
        assert_eq!(dragon.isbn.as_deref(), Some("2266028790"));
    }
}
