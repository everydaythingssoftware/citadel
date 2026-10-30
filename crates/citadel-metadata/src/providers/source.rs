use crate::model::MetadataProvider;

/// A config-driven SRU endpoint. Adding a national library that speaks
/// SRU/MARCXML is a new `SruEndpoint` row plus a match arm in [`endpoint`],
/// not new code.
pub struct SruEndpoint {
    pub provider: MetadataProvider,
    /// The live endpoint; tests and hosts can point a client elsewhere
    /// through [`crate::Endpoints`].
    pub base_url: &'static str,
    pub version: &'static str,
    pub record_schema: &'static str,
    /// CQL index for ISBN lookups (e.g. `bath.isbn`, or DNB's `num`).
    pub isbn_index: &'static str,
    /// CQL index for free-text/title lookups.
    pub title_index: &'static str,
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
    isbn_index: "bath.isbn",
    title_index: "bath.title",
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
    isbn_index: "num",
    title_index: "tit",
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
    isbn_index: "pica.isb",
    title_index: "pica.tit",
    max_records: 5,
    timeout_ms: 8_000,
};
