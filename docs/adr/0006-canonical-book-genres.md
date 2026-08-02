# 6. Store resolved book genres in a Calibre custom column

Status: Accepted - 2026-09-23

## Context

Citadel needs a stable Genre facet that is distinct from arbitrary Calibre tags and provider subject headings. Calibre has no universal built-in genre field, while Citadel already supports Calibre-compatible custom columns.

Provider data has different authority levels:

- Hardcover's documented search result includes the book's top five genres in `document.genres`. Its GraphQL schema also models categorized taggings, but Citadel does not need that broader relationship graph for v1.
- MARC 21 field 655 is explicitly a genre/form term. Other 6XX fields are subject access fields and are not genres.
- Open Library exposes subjects through the APIs Citadel uses. Subjects are classification hints, not authoritative genres.

Citadel must preserve manual choices when metadata is refreshed and keep the library portable to Calibre. OPDS is read-only and must not create schema merely because a catalog is browsed.

## Decision

Resolved genres live in a Calibre multi-value text custom column with label `citadel_genres` and display name `Genres`.

- A compatible existing `#citadel_genres` text/multiple column is adopted.
- An absent column is created only when a user explicitly accepts genre suggestions.
- An incompatible existing `#citadel_genres` column produces an actionable error. Citadel does not replace or reinterpret it.
- Another genre-like custom column, including `#genres`, is never adopted implicitly. A future explicit mapping may opt into one.
- OPDS and other reads treat an absent column as an empty genre vocabulary and never create it.

Provider results carry genre candidates separately from subjects. A candidate records its display name, provider field, and optional source vocabulary. Only these inputs are authoritative in v1:

- Hardcover search result genres.
- MARC 655 genre/form terms, retaining subfield 2 when present as the vocabulary.

Open Library subjects and MARC topical/subject fields remain subject suggestions and are never silently promoted.

Citadel uses provider-native labels rather than imposing a new universal taxonomy. It trims and collapses whitespace, rejects empty values, and deduplicates case-insensitively while preserving the first display spelling and deterministic provider order. Unknown labels remain valid. Alias maps, hierarchy, confidence scoring, and cross-provider vocabulary mapping require evidence and are deferred.

Stored genres are user-authoritative:

- Choosing a metadata record does not itself change genres. New and existing-book flows require an explicit genre acceptance action.
- On an existing book, lookup results are suggestions. Applying other metadata does not overwrite stored genres; the user explicitly accepts or edits genre suggestions.
- A refresh never silently replaces a non-empty genre list.
- The generic custom-field editor remains an escape hatch and edits the same `#citadel_genres` value.

The OPDS Genre vocabulary and books-by-genre queries read only resolved values from `#citadel_genres`. Provider-specific logic never enters the OPDS crate.

## Consequences

- Genre assignments travel with the Calibre library and are visible/editable in Calibre.
- Citadel does not need app-owned companion metadata or hidden provenance state to protect manual edits.
- Provider provenance exists on lookup candidates, while the accepted stored list intentionally represents the user's resolved choice.
- Libraries without accepted genre data show an empty Genre section.
- Future taxonomy or automatic-merge work can add explicit provenance storage through a separate migration without changing the v1 OPDS contract.

## Sources

- [Hardcover search API guide](https://github.com/hardcoverapp/hardcover-docs/blob/main/src/content/docs/api/guides/Searching.mdx)
- [MARC 21 field 655 — Index Term, Genre/Form](https://www.loc.gov/marc/bibliographic/concise/bd655.html)
- [Open Library API documentation](https://openlibrary.org/developers/api)
