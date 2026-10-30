use crate::metadata::model::MetadataProvider;

/// The bibliographic format an endpoint's records are in. It picks the field
/// mapping: the XML structure is shared, but the tags mean different things
/// (MARC21 `245` and UNIMARC `200` are both the title).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordFormat {
    /// MARC21 in the MARC21/slim namespace (LoC, DNB, K10plus).
    Marc21,
    /// UNIMARC in the MARCXchange namespace (BnF).
    Unimarc,
}

/// A config-driven SRU endpoint. Adding a national library that speaks
/// SRU with MARC21 or UNIMARC records is a new `SruEndpoint` row plus a match
/// arm in [`endpoint`], not new code.
pub struct SruEndpoint {
    pub provider: MetadataProvider,
    pub base_url: &'static str,
    pub version: &'static str,
    pub record_schema: &'static str,
    pub record_format: RecordFormat,
    /// CQL index for ISBN lookups (e.g. `bath.isbn`, or DNB's `num`).
    pub isbn_index: &'static str,
    /// CQL relation for ISBN lookups. `=` yields the bare `index=term` form;
    /// a named relation (`adj`) yields `index adj "term"`.
    pub isbn_relation: &'static str,
    /// The ISBN index matches exactly but only on the form printed in the
    /// record: query both the ISBN-10 and ISBN-13 forms, and keep hits whose
    /// record lacks an ISBN field instead of filtering them out.
    pub exact_isbn_index: bool,
    /// CQL index for free-text/title lookups.
    pub title_index: &'static str,
    /// CQL relation for title lookups (`=`, or e.g. `all` for every word).
    pub title_relation: &'static str,
    /// A broader index (matching any record field, so author and publisher
    /// words count) to retry a title lookup against when the title index finds
    /// nothing, e.g. "titre, auteur, éditeur" typed as one query.
    pub title_fallback_index: Option<&'static str>,
    /// Extra CQL clause ANDed onto title lookups (e.g. printed texts only).
    pub title_filter: Option<&'static str>,
    pub max_records: u32,
    pub timeout_ms: u64,
}

/// The SRU endpoint for a provider, or `None` if the provider is not an SRU
/// source (Hardcover, Open Library).
pub fn endpoint(provider: MetadataProvider) -> Option<&'static SruEndpoint> {
    match provider {
        MetadataProvider::Loc => Some(&LOC),
        MetadataProvider::Dnb => Some(&DNB),
        MetadataProvider::K10plus => Some(&K10PLUS),
        MetadataProvider::Bnf => Some(&BNF),
        _ => None,
    }
}

/// Library of Congress. Keyless. Plain HTTP on the Z39.50 gateway port; can be
/// slow, so a generous timeout. Verified live.
static LOC: SruEndpoint = SruEndpoint {
    provider: MetadataProvider::Loc,
    base_url: "http://lx2.loc.gov:210/lcdb",
    version: "1.1",
    record_schema: "marcxml",
    record_format: RecordFormat::Marc21,
    isbn_index: "bath.isbn",
    isbn_relation: "=",
    exact_isbn_index: false,
    title_index: "bath.title",
    title_relation: "=",
    title_fallback_index: None,
    title_filter: None,
    max_records: 3,
    timeout_ms: 25_000,
};

/// Deutsche Nationalbibliothek. Keyless, HTTPS, same MARC21/slim record
/// namespace as LoC. Verified live.
static DNB: SruEndpoint = SruEndpoint {
    provider: MetadataProvider::Dnb,
    base_url: "https://services.dnb.de/sru/dnb",
    version: "1.1",
    record_schema: "MARC21-xml",
    record_format: RecordFormat::Marc21,
    isbn_index: "num",
    isbn_relation: "=",
    exact_isbn_index: false,
    title_index: "tit",
    title_relation: "=",
    title_fallback_index: None,
    title_filter: None,
    max_records: 5,
    timeout_ms: 8_000,
};

/// K10plus union catalogue (GBV/SWB, DE-627). Keyless, HTTPS, MARC21/slim. Very
/// broad coverage including international titles. Verified live.
static K10PLUS: SruEndpoint = SruEndpoint {
    provider: MetadataProvider::K10plus,
    base_url: "https://sru.k10plus.de/opac-de-627",
    version: "1.1",
    record_schema: "marcxml",
    record_format: RecordFormat::Marc21,
    isbn_index: "pica.isb",
    isbn_relation: "=",
    exact_isbn_index: false,
    title_index: "pica.tit",
    title_relation: "=",
    title_fallback_index: None,
    title_filter: None,
    max_records: 5,
    timeout_ms: 8_000,
};

/// Bibliothèque nationale de France. Keyless, HTTPS, UNIMARC in MARCXchange.
/// Its ISBN index holds only the printed form and its title index is
/// unranked, so titles are narrowed to printed texts. Data is under the
/// Licence Ouverte / Open Licence, which requires crediting the BnF as the
/// source (done in the provider's settings description). Verified live.
static BNF: SruEndpoint = SruEndpoint {
    provider: MetadataProvider::Bnf,
    base_url: "https://catalogue.bnf.fr/api/SRU",
    version: "1.2",
    record_schema: "unimarcXchange",
    record_format: RecordFormat::Unimarc,
    isbn_index: "bib.isbn",
    isbn_relation: "adj",
    exact_isbn_index: true,
    title_index: "bib.title",
    title_relation: "all",
    title_fallback_index: Some("bib.anywhere"),
    title_filter: Some("bib.doctype any \"a\""),
    max_records: 5,
    timeout_ms: 10_000,
};
