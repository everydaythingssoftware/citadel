//! Book-metadata providers. Hardcover (GraphQL), the national and union library
//! catalogues (SRU: MARCXML for LoC, DNB and K10plus, UNIMARC for the BnF), and
//! Open Library (JSON-REST) all return the unified [`model::BookMetadata`] from
//! a single search call.

pub mod commands;
pub mod model;

mod hardcover;
mod http;
mod marcxml;
mod openlibrary;
mod source;
mod sru;
mod unimarc;
