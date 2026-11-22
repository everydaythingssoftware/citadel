# 16. EPUB package reader

Status: Accepted - 2026-11-21

## Context

Citadel reads an EPUB's metadata and cover when a book is staged: an upload to
the server, or a file chosen on the desktop. Adding the book reads the cover
again. Until now libcalibre did this with the GPL-3.0 `epub` crate (2.1.5),
which builds an xml-rs DOM of `container.xml`, the package document (OPF) and
the NCX, and walks it recursively. A security review (C-01, H-02, L-27) found
that any user who can upload could take down the whole process, server or
desktop:

- An OPF with about 40,000 nested elements in `<metadata>` overflowed the
  stack in the crate's recursive element search. The process aborted, and
  `catch_unwind` can't catch that. A `toc.ncx` with 10,000 nested
  `navPoint`s did the same while building the table of contents, which Citadel
  never uses.
- 1,000 namespace declarations over 10,000 elements took 1.5 GiB, because
  xml-rs copies the namespace map for every element. `container.xml`, the OPF
  and the NCX were read to the end whatever their size: a 205 KB file grew to
  419 MiB.
- A rootfile `full-path` of `""` or `"/"` panicked.

Staging read each file twice (metadata, then cover), and adding it read it a
third time.

Across 287 real and test EPUBs (W3C `epub-tests` and `epub3-samples`, 24
Project Gutenberg and 9 Standard Ebooks books), no package document nests
deeper than 4 elements.

## Decision

EPUBs are read by a new workspace crate, `crates/citadel-epub` (MIT), written
from scratch. libcalibre no longer depends on `epub`, and nothing in the
workspace depends on xml-rs.

- **Basis.** Behaviour follows EPUB 3.3 (§4 the OCF container, §5 the package
  document), EPUB Reading Systems 3.3 (use the first package rootfile, collapse
  whitespace in metadata) and Readium's documented metadata mapping. The
  identifier is the `dc:identifier` that `package@unique-identifier` names. The
  main title is the one refined with `title-type` `main`. Creators take
  `file-as` and `role` from EPUB 3 refinements or EPUB 2 `opf:` attributes, and
  authors are creators with no role, an unknown role or `aut`. The cover is the
  manifest item with the `cover-image` property, or else the EPUB 2
  `<meta name="cover">`. The published date is the `dc:date` with `opf:event`
  `publication`, or else the first one without an event. Dublin Core is matched
  by namespace, not prefix. epub-rs's quirks aren't reproduced, and Calibre
  isn't a reference.
- **Only two documents.** Only `META-INF/container.xml` and the package document
  are parsed. The navigation document and NCX are never opened. The archive is
  opened once per read, and `book_file::read_book` returns the metadata and the
  cover together.
- **Streaming, never recursive.** Both documents go through quick-xml's pull
  reader. Open elements are a counter and a small stack, so no code path
  recurses on the input's structure. That rule holds for any future parsing in
  the crate. Documents are transcoded to UTF-8 first (BOM, then the XML
  declaration). There's no DTD processing, so an entity other than XML's five
  and character references makes the document malformed.
- **Limits** are named constants in `citadel_epub::limits`, not configuration:
  - `container.xml` up to 64 KiB and the OPF up to 8 MiB. Both are read through
    `take(cap + 1)`, so the declared size isn't trusted.
  - Elements nest at most 256 deep, and a document holds at most 250,000
    elements.
  - An element has at most 128 attributes, and at most 256 namespace bindings
    are in scope at once.
  - The metadata holds at most 4,096 items, and a text value is at most 64 KiB.
  - Before the zip crate sees the archive, every end record it could use is
    checked: up to four end-of-central-directory records (it falls back from
    the newest), and every zip64 record that ends at the zip64 locator. An
    archive is refused if any declares more than 20,000 entries, a central
    directory over 4 MiB, or zip64 extensible data over 4 MiB. The directory
    the zip crate reads first is then walked to confirm it holds those
    entries within that space.
  - A rootfile path must be non-empty and relative, must not start with `/`,
    and must not leave the container.

  The margin over real books is large, so breaking any limit **refuses** the
  file. Nothing is truncated.
- **Refused vs unreadable.** `EpubError::Refused` (a limit, or an invalid
  rootfile or container) means the file mustn't be added. The upload is
  discarded and the server answers 422 with error code `unprocessable` and a
  plain reason, such as "This EPUB's package file is larger than 8 MiB.". The
  desktop shows that same reason on the file's row (ADR 0014).
  `EpubError::Unreadable` (not a zip, missing container or OPF, no spine,
  malformed XML) keeps the old lenient behaviour: the book is staged with a
  title taken from its file name. EPUB reading also runs inside the
  `catch_unwind` guard that MOBI uses.

## Consequences

- An upload can no longer abort the server or the desktop, or make it allocate
  without bound. Tests run each hostile case in a child process on a 256 KiB
  stack with a 32 MiB heap ceiling (`crates/citadel-epub/tests/hostile.rs`).
  The real server binary is tested the same way
  (`hostile_epubs_are_refused_and_server_survives`), and a weekly fuzz job
  (`.github/workflows/fuzz.yml`) adds coverage.
- Some metadata changes on purpose. Translators, editors and other non-author
  creators are no longer listed as authors. The unique identifier is preferred
  over the first one. Refined main titles win. Whitespace is collapsed. A
  date-time such as `2018-11-06T00:00:00Z` now gives a publication date.
- Creators' `file-as` is read but not yet stored: staging and `BookAdd` have no
  author-sort field. Series (`belongs-to-collection`, `calibre:series`) is out
  of scope. Both are follow-ups.
- A package that is valid but past a limit would be refused. None of the 287
  books in the corpus is (`cargo run -p citadel-epub --example scan -- <dir>`).
- The pre-check holds every end record the zip crate could fall back to to
  the limits, but it doesn't re-implement every check the zip crate makes on
  individual headers.
