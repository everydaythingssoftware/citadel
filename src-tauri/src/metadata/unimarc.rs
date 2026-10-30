use crate::metadata::marcxml::{extract_year, read_marc_records, strip_trailing_punct, RawRecord};
use crate::metadata::model::{
    normalize_genre_candidates, pick_preferred_isbn, BookMetadata, GenreCandidate, MetadataProvider,
};

/// The MARCXchange record namespace the BnF serves UNIMARC records in.
const MARCXCHANGE_NS: &[u8] = b"info:lc/xmlns/marcxchange-v2";

/// Parse an SRU `searchRetrieveResponse` carrying UNIMARC records in
/// MARCXchange. As with MARC21, an empty or diagnostics-only response yields an
/// empty vec.
pub fn parse_envelope(xml: &str, provider: MetadataProvider) -> Result<Vec<BookMetadata>, String> {
    let raw_records = read_marc_records(xml, MARCXCHANGE_NS)?;
    Ok(raw_records
        .iter()
        .map(|r| map_record(r, provider))
        .collect())
}

fn map_record(rec: &RawRecord, provider: MetadataProvider) -> BookMetadata {
    let title_field = rec.datafields("200").next();
    let title = title_field
        .and_then(|f| f.first(b'a'))
        .map(strip_trailing_punct)
        .unwrap_or_default();
    // 200$e is "other title information"; 200$b is the material designation
    // ("Texte imprimé"), never a subtitle.
    let subtitle = title_field
        .and_then(|f| f.first(b'e'))
        .map(strip_trailing_punct)
        .filter(|s| !s.is_empty());
    let (series, series_index) = series(rec);
    let collection = collection(rec, series.as_deref());

    BookMetadata {
        provider,
        provider_id: provider_id(rec),
        identifier_label: provider.identifier_label().to_string(),
        title,
        subtitle,
        authors: authors(rec),
        isbn: isbn(rec),
        release_year: release_year(rec),
        description: rec
            .datafields("330")
            .next()
            .and_then(|f| f.first(b'a'))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        image_url: None,
        publisher: publisher(rec),
        subjects: subjects(rec),
        genre_candidates: genres(rec),
        language_code: rec
            .datafields("101")
            .next()
            .and_then(|f| f.first(b'a'))
            .map(|s| s.trim().to_string())
            .filter(|s| s.len() == 3 && s.chars().all(|c| c.is_ascii_alphabetic())),
        slug: None,
        series,
        series_index,
        collection,
    }
}

/// The ARK name (`cb35224436w`) from the `003` permalink, so the record
/// deep-links to catalogue.bnf.fr; the `001` control number is the fallback.
fn provider_id(rec: &RawRecord) -> String {
    rec.controlfield("003")
        .filter(|url| url.contains("/ark:/"))
        .and_then(|url| url.trim_end_matches('/').rsplit('/').next())
        .or_else(|| rec.controlfield("001"))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Primary (700) and alternative (701) personal responsibility, then corporate
/// and meeting names (710/711). Secondary responsibility (702 translators,
/// illustrators; 712) is deliberately left out.
fn authors(rec: &RawRecord) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for field in &rec.datafields {
        let name = match field.tag.as_str() {
            "700" | "701" => field
                .first(b'a')
                .map(|family| personal_name(family, field.first(b'b'))),
            "710" | "711" => field.first(b'a').map(strip_trailing_punct),
            _ => None,
        };
        if let Some(name) = name.filter(|n| !n.is_empty()) {
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

/// UNIMARC splits personal names into `$a` (entry element) and `$b` (rest of
/// the name), so no comma-splitting is needed to get display order.
fn personal_name(family: &str, given: Option<&str>) -> String {
    let family = family.trim().trim_end_matches(',').trim();
    match given.map(|g| g.trim().trim_end_matches(',').trim()) {
        Some(given) if !given.is_empty() => format!("{given} {family}"),
        _ => family.to_string(),
    }
}

fn isbn(rec: &RawRecord) -> Option<String> {
    let candidates: Vec<String> = rec
        .datafields("010")
        .filter_map(|f| f.first(b'a'))
        .map(|s| s.to_string())
        .collect();
    pick_preferred_isbn(&candidates)
}

/// The publication statement: 214 with second indicator `0` (publication, the
/// RDA-era field), else the legacy 210.
fn imprint(rec: &RawRecord, code: u8) -> Option<&str> {
    rec.datafields("214")
        .filter(|f| f.ind2 == b'0')
        .find_map(|f| f.first(code))
        .or_else(|| rec.datafields("210").find_map(|f| f.first(code)))
}

fn publisher(rec: &RawRecord) -> Option<String> {
    imprint(rec, b'c')
        .map(strip_trailing_punct)
        .filter(|s| !s.is_empty())
}

/// From the imprint date (e.g. "DL 2018"), falling back to Date 1 of the 100
/// general processing data (chars 9-12).
fn release_year(rec: &RawRecord) -> Option<i32> {
    imprint(rec, b'd').and_then(extract_year).or_else(|| {
        rec.datafields("100")
            .next()
            .and_then(|f| f.first(b'a'))
            .and_then(|s| s.get(9..13))
            .and_then(extract_year)
    })
}

fn subjects(rec: &RawRecord) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for field in &rec.datafields {
        let value = match field.tag.as_str() {
            "600" => field.first(b'a').map(|family| {
                let family = strip_trailing_punct(family);
                match field.first(b'b').map(strip_trailing_punct) {
                    Some(given) if !given.is_empty() => format!("{family}, {given}"),
                    _ => family,
                }
            }),
            "601" | "602" | "604" | "605" | "606" | "607" => {
                field.first(b'a').map(strip_trailing_punct)
            }
            _ => None,
        };
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            if !out.iter().any(|s| s.eq_ignore_ascii_case(&value)) {
                out.push(value);
            }
        }
    }
    out
}

fn genres(rec: &RawRecord) -> Vec<GenreCandidate> {
    normalize_genre_candidates(rec.datafields("608").filter_map(|field| {
        let name = field.first(b'a').map(strip_trailing_punct)?;
        (!name.is_empty()).then(|| GenreCandidate {
            name,
            source: "unimarc:608".to_string(),
            vocabulary: field.first(b'2').map(strip_trailing_punct),
        })
    }))
}

/// The set a book belongs to (461 link, e.g. "Harry Potter" vol. 1). Publisher
/// collections (225 / 410, e.g. "Folio junior" no. 899) are not series and are
/// ignored.
fn series(rec: &RawRecord) -> (Option<String>, Option<f64>) {
    let Some(field) = rec.datafields("461").find(|f| {
        f.first(b't')
            .is_some_and(|t| !strip_trailing_punct(t).is_empty())
    }) else {
        return (None, None);
    };
    let name = field.first(b't').map(strip_trailing_punct);
    let index = field.first(b'v').and_then(parse_series_index);
    (name, index)
}

/// The publisher's collection (225, e.g. "Presses pocket" no. 5341 or "Folio
/// junior" no. 899), as "name number". A 225 repeating the series name (the
/// 461 link is also listed there) is skipped. `$i` is a subseries title and is
/// not part of the name.
fn collection(rec: &RawRecord, series: Option<&str>) -> Option<String> {
    rec.datafields("225").find_map(|field| {
        let name = field.first(b'a').map(strip_trailing_punct)?;
        if name.is_empty() || series.is_some_and(|s| s.eq_ignore_ascii_case(&name)) {
            return None;
        }
        let number = field
            .first(b'v')
            .map(|v| v.trim())
            .filter(|v| !v.is_empty());
        Some(match number {
            Some(number) => format!("{name} {number}"),
            None => name,
        })
    })
}

/// The first number in a volume designation: "1" -> 1, "T. 3" -> 3,
/// "2,5" -> 2.5.
fn parse_series_index(raw: &str) -> Option<f64> {
    let start = raw.find(|c: char| c.is_ascii_digit())?;
    let number: String = raw[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
        .map(|c| if c == ',' { '.' } else { c })
        .collect();
    number.trim_end_matches('.').parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HARRY_POTTER: &str = include_str!("fixtures/bnf_9782070584628.xml");
    const SAPIENS: &str = include_str!("fixtures/bnf_9782226257017.xml");
    const L_ETRANGER: &str = include_str!("fixtures/bnf_2070360024.xml");
    const PETIT_PRINCE: &str = include_str!("fixtures/bnf_9782070612758.xml");

    fn parse_one(xml: &str) -> BookMetadata {
        let mut records = parse_envelope(xml, MetadataProvider::Bnf).unwrap();
        assert_eq!(records.len(), 1);
        records.remove(0)
    }

    #[test]
    fn parses_translated_series_volume() {
        let b = parse_one(HARRY_POTTER);
        assert_eq!(b.title, "Harry Potter à l'école des sorciers");
        assert_eq!(b.subtitle, None);
        // The translator (702) is not an author.
        assert_eq!(b.authors, vec!["J. K. Rowling"]);
        assert_eq!(b.isbn.as_deref(), Some("9782070584628"));
        assert_eq!(b.publisher.as_deref(), Some("Gallimard jeunesse"));
        assert_eq!(b.release_year, Some(2018));
        assert_eq!(b.language_code.as_deref(), Some("fre"));
        assert_eq!(b.series.as_deref(), Some("Harry Potter"));
        assert_eq!(b.series_index, Some(1.0));
        // The 225 repeating the series is skipped; the publisher's collection stays.
        assert_eq!(b.collection.as_deref(), Some("Folio junior 899"));
        assert_eq!(b.provider_id, "cb45595763x");
        assert_eq!(b.identifier_label, "bnf");
        assert!(b.image_url.is_none());
    }

    #[test]
    fn parses_subtitle_and_subjects() {
        let b = parse_one(SAPIENS);
        assert_eq!(b.title, "Sapiens");
        assert_eq!(
            b.subtitle.as_deref(),
            Some("une brève histoire de l'humanité")
        );
        assert_eq!(b.authors, vec!["Yuval Noah Harari"]);
        assert_eq!(b.publisher.as_deref(), Some("Albin Michel"));
        assert_eq!(b.release_year, Some(2015));
        assert_eq!(b.collection, None);
        assert_eq!(b.subjects, vec!["Histoire universelle", "Civilisation"]);
        assert!(b.genre_candidates.is_empty());
        assert_eq!(b.series, None);
    }

    #[test]
    fn keeps_isbnless_record_and_ignores_publisher_collection() {
        let b = parse_one(L_ETRANGER);
        assert_eq!(b.title, "L'Étranger");
        assert_eq!(b.authors, vec!["Albert Camus"]);
        // The BnF's UNIMARC export of this 1971 record carries no 010.
        assert_eq!(b.isbn, None);
        assert_eq!(b.publisher.as_deref(), Some("Gallimard"));
        assert_eq!(b.release_year, Some(1971));
        // "Folio" no. 2 is a publisher collection (225/410), not a series.
        assert_eq!(b.series, None);
        assert_eq!(b.series_index, None);
        assert_eq!(b.collection.as_deref(), Some("Folio 2"));
        assert_eq!(b.provider_id, "cb35224436w");
    }

    #[test]
    fn parses_summary_and_genre() {
        let b = parse_one(PETIT_PRINCE);
        assert_eq!(b.title, "Le petit prince");
        assert_eq!(b.collection.as_deref(), Some("Folio junior 100"));
        assert_eq!(b.authors, vec!["Antoine de Saint-Exupéry"]);
        assert!(b
            .description
            .as_deref()
            .is_some_and(|d| d.starts_with("Le récit des aventures poétiques")));
        assert_eq!(b.genre_candidates.len(), 1);
        assert_eq!(b.genre_candidates[0].name, "Romans");
        assert_eq!(b.genre_candidates[0].source, "unimarc:608");
        assert_eq!(b.genre_candidates[0].vocabulary.as_deref(), Some("CNLJ"));
    }

    #[test]
    fn empty_envelope_yields_no_records() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?><srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/"><srw:version>1.2</srw:version><srw:numberOfRecords>0</srw:numberOfRecords><srw:records/></srw:searchRetrieveResponse>"#;
        assert!(parse_envelope(xml, MetadataProvider::Bnf)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn marc21_records_are_not_read_as_unimarc() {
        let xml = include_str!("fixtures/loc_9780553103540.xml");
        assert!(parse_envelope(xml, MetadataProvider::Bnf)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn parses_series_index() {
        assert_eq!(parse_series_index("1"), Some(1.0));
        assert_eq!(parse_series_index("T. 3"), Some(3.0));
        assert_eq!(parse_series_index("2,5"), Some(2.5));
        assert_eq!(parse_series_index("12."), Some(12.0));
        assert_eq!(parse_series_index("hors série"), None);
    }

    #[test]
    fn builds_personal_names_in_display_order() {
        assert_eq!(personal_name("Rowling", Some("J. K.")), "J. K. Rowling");
        assert_eq!(personal_name("Colette", None), "Colette");
        assert_eq!(personal_name("Camus,", Some(" Albert ")), "Albert Camus");
    }
}
