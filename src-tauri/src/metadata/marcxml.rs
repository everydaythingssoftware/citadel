use quick_xml::events::Event;
use quick_xml::name::ResolveResult;
use quick_xml::reader::NsReader;

use crate::metadata::model::{
    normalize_genre_candidates, pick_preferred_isbn, BookMetadata, GenreCandidate, MetadataProvider,
};

/// The MARC21/slim record namespace, shared by LoC and DNB. Matching on it lets
/// us tell the MARC `<record>` apart from the SRU envelope's `<zs:record>`.
const MARC_NS: &[u8] = b"http://www.loc.gov/MARC21/slim";

struct DataField {
    tag: String,
    ind2: u8,
    subfields: Vec<(u8, String)>,
}

impl DataField {
    fn first(&self, code: u8) -> Option<&str> {
        self.subfields
            .iter()
            .find(|(c, _)| *c == code)
            .map(|(_, v)| v.as_str())
    }
}

struct RawRecord {
    controlfields: Vec<(String, String)>,
    datafields: Vec<DataField>,
}

impl RawRecord {
    fn controlfield(&self, tag: &str) -> Option<&str> {
        self.controlfields
            .iter()
            .find(|(t, _)| t == tag)
            .map(|(_, v)| v.as_str())
    }

    fn datafields<'a>(&'a self, tag: &'a str) -> impl Iterator<Item = &'a DataField> + 'a {
        self.datafields.iter().filter(move |d| d.tag == tag)
    }
}

/// Parse an SRU `searchRetrieveResponse` envelope into zero or more book
/// records. A zero-record response (or one carrying only diagnostics) yields an
/// empty vec rather than an error, so the command layer can treat it as a clean
/// "no match".
pub fn parse_envelope(xml: &str, provider: MetadataProvider) -> Result<Vec<BookMetadata>, String> {
    let raw_records = read_marc_records(xml)?;
    Ok(raw_records
        .iter()
        .map(|r| map_record(r, provider))
        .collect())
}

fn read_marc_records(xml: &str) -> Result<Vec<RawRecord>, String> {
    let mut reader = NsReader::from_str(xml);
    let mut buf = Vec::new();

    let mut records: Vec<RawRecord> = Vec::new();
    let mut in_record = false;
    let mut current: Option<RawRecord> = None;
    // The currently open leaf (a controlfield or a subfield) accumulating text.
    let mut control_tag: Option<String> = None;
    let mut subfield_code: Option<u8> = None;
    let mut text_buf = String::new();

    loop {
        match reader.read_resolved_event_into(&mut buf) {
            Ok((resolve, Event::Start(e))) => {
                let is_marc = matches!(resolve, ResolveResult::Bound(ns) if ns.as_ref() == MARC_NS);
                let local = e.local_name();
                let name = local.as_ref();

                if !in_record {
                    if is_marc && name == b"record" {
                        in_record = true;
                        current = Some(RawRecord {
                            controlfields: Vec::new(),
                            datafields: Vec::new(),
                        });
                    }
                    buf.clear();
                    continue;
                }

                match name {
                    b"controlfield" => {
                        control_tag = attr(&e, b"tag");
                        text_buf.clear();
                    }
                    b"datafield" => {
                        if let Some(rec) = current.as_mut() {
                            rec.datafields.push(DataField {
                                tag: attr(&e, b"tag").unwrap_or_default(),
                                ind2: attr(&e, b"ind2")
                                    .and_then(|s| s.bytes().next())
                                    .unwrap_or(b' '),
                                subfields: Vec::new(),
                            });
                        }
                    }
                    b"subfield" => {
                        subfield_code = attr(&e, b"code").and_then(|s| s.bytes().next());
                        text_buf.clear();
                    }
                    _ => {}
                }
            }
            Ok((_, Event::Text(e))) => {
                if in_record && (control_tag.is_some() || subfield_code.is_some()) {
                    if let Ok(text) = e.xml_content() {
                        text_buf.push_str(&text);
                    }
                }
            }
            // quick-xml emits entity references (`&amp;`, `&#233;`) as their own
            // events; resolve them so text like "Kiepenheuer & Witsch" survives.
            Ok((_, Event::GeneralRef(e))) => {
                if in_record && (control_tag.is_some() || subfield_code.is_some()) {
                    if let Some(resolved) = resolve_entity(&e) {
                        text_buf.push_str(&resolved);
                    }
                }
            }
            Ok((resolve, Event::End(e))) => {
                let is_marc = matches!(resolve, ResolveResult::Bound(ns) if ns.as_ref() == MARC_NS);
                let local = e.local_name();
                let name = local.as_ref();

                if !in_record {
                    buf.clear();
                    continue;
                }

                match name {
                    b"controlfield" => {
                        if let (Some(tag), Some(rec)) = (control_tag.take(), current.as_mut()) {
                            rec.controlfields.push((tag, text_buf.trim().to_string()));
                        }
                        text_buf.clear();
                    }
                    b"subfield" => {
                        if let (Some(code), Some(rec)) = (subfield_code.take(), current.as_mut()) {
                            if let Some(field) = rec.datafields.last_mut() {
                                field.subfields.push((code, text_buf.trim().to_string()));
                            }
                        }
                        text_buf.clear();
                    }
                    b"record" if is_marc => {
                        in_record = false;
                        if let Some(rec) = current.take() {
                            records.push(rec);
                        }
                    }
                    _ => {}
                }
            }
            Ok((_, Event::Eof)) => break,
            Err(e) => return Err(format!("Failed to parse MARCXML: {e}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(records)
}

/// Resolve a general entity reference to its text: numeric character refs
/// (`&#233;`, `&#xE9;`) and the five predefined XML entities. Unknown named
/// entities are dropped.
fn resolve_entity(e: &quick_xml::events::BytesRef) -> Option<String> {
    if let Ok(Some(c)) = e.resolve_char_ref() {
        return Some(c.to_string());
    }
    let name = e.decode().ok()?;
    let ch = match name.as_ref() {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        _ => return None,
    };
    Some(ch.to_string())
}

fn attr(e: &quick_xml::events::BytesStart, key: &[u8]) -> Option<String> {
    e.attributes().flatten().find_map(|a| {
        if a.key.local_name().as_ref() == key {
            a.unescape_value().ok().map(|v| v.trim().to_string())
        } else {
            None
        }
    })
}

// ---------------------------------------------------------------------------
// MARC record -> BookMetadata
// ---------------------------------------------------------------------------

fn map_record(rec: &RawRecord, provider: MetadataProvider) -> BookMetadata {
    let title_field = rec.datafields("245").next();
    let title = title_field
        .and_then(|f| f.first(b'a'))
        .map(strip_trailing_punct)
        .unwrap_or_default();
    let subtitle = title_field
        .and_then(|f| f.first(b'b'))
        .map(strip_trailing_punct)
        .filter(|s| !s.is_empty());

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
            .datafields("520")
            .next()
            .and_then(|f| f.first(b'a'))
            .map(strip_trailing_punct)
            .filter(|s| !s.is_empty()),
        image_url: None,
        publisher: publisher(rec),
        subjects: subjects(rec),
        genre_candidates: genres(rec),
        language_code: language_code(rec),
        slug: None,
    }
}

/// LCCN (`010$a`) is preferred so deep-links resolve at lccn.loc.gov; the
/// record control number (`001`) is the fallback.
fn provider_id(rec: &RawRecord) -> String {
    rec.datafields("010")
        .next()
        .and_then(|f| f.first(b'a'))
        .map(|s| s.split_whitespace().collect::<String>())
        .filter(|s| !s.is_empty())
        .or_else(|| rec.controlfield("001").map(|s| s.trim().to_string()))
        .unwrap_or_default()
}

fn authors(rec: &RawRecord) -> Vec<String> {
    let mut out = Vec::new();
    for field in &rec.datafields {
        match field.tag.as_str() {
            "100" | "700" => {
                if let Some(name) = field.first(b'a') {
                    out.push(invert_name(name));
                }
            }
            // Corporate / meeting names are not personal; do not invert.
            "110" | "710" | "111" | "711" => {
                if let Some(name) = field.first(b'a') {
                    out.push(strip_trailing_punct(name));
                }
            }
            _ => {}
        }
    }
    out.retain(|s| !s.is_empty());
    out
}

/// MARC stores personal names as "Last, First". Flip to display order. A second
/// comma (e.g. a "Jr." suffix) is a documented known-limitation: only the first
/// chunk after the comma is treated as given names.
fn invert_name(raw: &str) -> String {
    // Strip trailing relator punctuation (comma/space) but keep a trailing
    // period — it is usually part of an initial ("George R. R.").
    let cleaned = raw.trim().trim_end_matches([',', ' ']);
    match cleaned.split_once(", ") {
        Some((last, rest)) => {
            let first = rest.split(',').next().unwrap_or(rest).trim();
            format!("{first} {last}").trim().to_string()
        }
        None => cleaned.to_string(),
    }
}

fn isbn(rec: &RawRecord) -> Option<String> {
    let candidates: Vec<String> = rec
        .datafields("020")
        .filter_map(|f| f.first(b'a'))
        .map(|s| s.to_string())
        .collect();
    pick_preferred_isbn(&candidates)
}

fn publisher(rec: &RawRecord) -> Option<String> {
    // Prefer the 264 with second indicator '1' (publication), then any 264,
    // then the legacy 260.
    rec.datafields("264")
        .find(|f| f.ind2 == b'1')
        .and_then(|f| f.first(b'b'))
        .or_else(|| rec.datafields("264").next().and_then(|f| f.first(b'b')))
        .or_else(|| rec.datafields("260").next().and_then(|f| f.first(b'b')))
        .map(strip_trailing_punct)
        .filter(|s| !s.is_empty())
}

fn release_year(rec: &RawRecord) -> Option<i32> {
    let from_imprint = rec
        .datafields("264")
        .find(|f| f.ind2 == b'1')
        .and_then(|f| f.first(b'c'))
        .or_else(|| rec.datafields("264").next().and_then(|f| f.first(b'c')))
        .or_else(|| rec.datafields("260").next().and_then(|f| f.first(b'c')))
        .and_then(extract_year);
    from_imprint.or_else(|| {
        rec.controlfield("008")
            .filter(|s| s.len() >= 11)
            .and_then(|s| s.get(7..11))
            .and_then(extract_year)
    })
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

fn subjects(rec: &RawRecord) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for field in &rec.datafields {
        if matches!(
            field.tag.as_str(),
            "600" | "610" | "611" | "630" | "648" | "650" | "651"
        ) {
            if let Some(value) = field.first(b'a') {
                let cleaned = strip_trailing_punct(value);
                if !cleaned.is_empty() && !out.iter().any(|s| s.eq_ignore_ascii_case(&cleaned)) {
                    out.push(cleaned);
                }
            }
        }
    }
    out
}

fn genres(rec: &RawRecord) -> Vec<GenreCandidate> {
    normalize_genre_candidates(rec.datafields("655").filter_map(|field| {
        let name = field.first(b'a').map(strip_trailing_punct)?;
        (!name.is_empty()).then(|| GenreCandidate {
            name,
            source: "marc:655".to_string(),
            vocabulary: field.first(b'2').map(strip_trailing_punct),
        })
    }))
}

/// MARC language from the 008 fixed field (chars 35-37), falling back to 041$a.
fn language_code(rec: &RawRecord) -> Option<String> {
    let from_008 = rec
        .controlfield("008")
        .filter(|s| s.len() >= 38)
        .and_then(|s| s.get(35..38))
        .map(|s| s.to_string())
        .filter(|s| s.chars().all(|c| c.is_ascii_alphabetic()) && s != "   ");
    from_008.or_else(|| {
        rec.datafields("041")
            .next()
            .and_then(|f| f.first(b'a'))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    })
}

/// Strip the trailing ISBD/MARC punctuation MARC fields carry (`/`, `:`, `;`,
/// `,`, `.`) along with surrounding whitespace.
fn strip_trailing_punct(s: &str) -> String {
    s.trim()
        .trim_end_matches([' ', '/', ':', ';', ','])
        .trim_end_matches('.')
        .trim_end()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOC_GAME_OF_THRONES: &str = include_str!("fixtures/loc_9780553103540.xml");
    const DNB_RECORD: &str = include_str!("fixtures/dnb_9783462001313.xml");
    const K10PLUS_RECORD: &str = include_str!("fixtures/k10plus_9780553103540.xml");

    #[test]
    fn parses_loc_record() {
        let records = parse_envelope(LOC_GAME_OF_THRONES, MetadataProvider::Loc).unwrap();
        assert_eq!(records.len(), 1);
        let b = &records[0];
        assert_eq!(b.title, "A game of thrones");
        assert_eq!(b.authors, vec!["George R. R. Martin"]);
        assert_eq!(b.isbn.as_deref(), Some("9780553103540"));
        assert_eq!(b.release_year, Some(1996));
        assert_eq!(b.publisher.as_deref(), Some("Bantam Books"));
        assert_eq!(b.language_code.as_deref(), Some("eng"));
        assert!(!b.subjects.iter().any(|s| s == "Fantasy fiction"));
        assert_eq!(b.genre_candidates.len(), 1);
        assert_eq!(b.genre_candidates[0].name, "Fantasy fiction");
        assert_eq!(b.genre_candidates[0].source, "marc:655");
        assert_eq!(b.identifier_label, "lccn");
        assert!(b.image_url.is_none());
    }

    #[test]
    fn parses_dnb_record() {
        let records = parse_envelope(DNB_RECORD, MetadataProvider::Dnb).unwrap();
        assert_eq!(records.len(), 1);
        let b = &records[0];
        assert!(!b.title.is_empty());
        assert_eq!(b.language_code.as_deref(), Some("ger"));
        assert_eq!(b.identifier_label, "dnb");
    }

    #[test]
    fn parses_k10plus_record() {
        let records = parse_envelope(K10PLUS_RECORD, MetadataProvider::K10plus).unwrap();
        assert_eq!(records.len(), 1);
        let b = &records[0];
        assert_eq!(b.title, "A game of thrones");
        assert_eq!(b.authors, vec!["George R. R. Martin"]);
        assert_eq!(b.language_code.as_deref(), Some("eng"));
        assert_eq!(b.identifier_label, "k10plus");
        // K10plus stores its PPN in 001 (no 010 LCCN).
        assert_eq!(b.provider_id, "1634799208");
        assert!(b.image_url.is_none());
    }

    #[test]
    fn empty_envelope_yields_no_records() {
        let xml = r#"<?xml version="1.0"?>
        <searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/">
          <version>1.1</version><numberOfRecords>0</numberOfRecords><records/>
        </searchRetrieveResponse>"#;
        let records = parse_envelope(xml, MetadataProvider::Loc).unwrap();
        assert!(records.is_empty());
    }

    #[test]
    fn corporate_author_is_not_inverted() {
        let xml = r#"<?xml version="1.0"?>
        <searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><records><record><recordData>
        <record xmlns="http://www.loc.gov/MARC21/slim">
          <datafield tag="110" ind1="2" ind2=" "><subfield code="a">United States. Congress.</subfield></datafield>
          <datafield tag="245" ind1="1" ind2="0"><subfield code="a">A report /</subfield></datafield>
        </record></recordData></record></records></searchRetrieveResponse>"#;
        let records = parse_envelope(xml, MetadataProvider::Loc).unwrap();
        assert_eq!(records[0].authors, vec!["United States. Congress"]);
    }

    #[test]
    fn resolves_entities_in_subfields() {
        let xml = r#"<?xml version="1.0"?>
        <searchRetrieveResponse xmlns="http://www.loc.gov/zing/srw/"><records><record><recordData>
        <record xmlns="http://www.loc.gov/MARC21/slim">
          <datafield tag="245" ind1="1" ind2="0"><subfield code="a">Sense &amp; sensibility /</subfield></datafield>
          <datafield tag="264" ind1=" " ind2="1"><subfield code="b">Kiepenheuer &amp; Witsch,</subfield></datafield>
        </record></recordData></record></records></searchRetrieveResponse>"#;
        let records = parse_envelope(xml, MetadataProvider::Dnb).unwrap();
        assert_eq!(records[0].title, "Sense & sensibility");
        assert_eq!(
            records[0].publisher.as_deref(),
            Some("Kiepenheuer & Witsch")
        );
    }

    #[test]
    fn inverts_personal_name() {
        assert_eq!(invert_name("Martin, George R. R."), "George R. R. Martin");
        assert_eq!(invert_name("Dostoyevsky, Fyodor,"), "Fyodor Dostoyevsky");
        assert_eq!(invert_name("Plato"), "Plato");
    }
}
