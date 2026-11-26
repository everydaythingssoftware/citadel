# 16. EPUB package reader

Status: Accepted - 2026-11-21

## Context

libcalibre read EPUB metadata with the GPL-3.0 `epub` crate, which builds a
DOM of `container.xml`, the package document and the NCX, then walks it
recursively. A few kilobytes of deeply nested XML overflowed the stack and
aborted the process, server or desktop. Namespace-heavy files used gigabytes,
entries were read without a size cap, and an empty rootfile path panicked.

## Decision

A new crate, `crates/citadel-epub` (MIT), reads EPUBs. Nothing in the
workspace depends on `epub` or xml-rs.

- It parses only `META-INF/container.xml` and the package document, streaming
  with quick-xml over zip, and never recurses on the input. The NCX and nav
  document are never opened.
- Metadata follows EPUB 3.3 and Reading Systems 3.3, with Readium's metadata
  mapping where they're silent. Where a field ends up in a Calibre library,
  it means what Calibre means: an ISBN identifier is preferred, and
  `original-publication` dates count.
- Limits are constants in `citadel_epub::limits`: an 8 MiB package document,
  nesting 256 deep, 250,000 elements, 20,000 zip entries. Real books are far
  below them, so a file past any limit is **refused**, not truncated. Every
  end record the zip crate could use is checked before it opens the archive.
- A refused file isn't added: the server answers 422 with the reason, and the
  web and desktop apps show it on the file's row. A file that is merely
  unreadable keeps the old fallback, a title from the file name.

## Consequences

- An upload can't abort the process or make it allocate without bound.
- Some metadata changes on purpose: non-author creators (translators,
  editors) aren't authors, refined main titles win, whitespace is collapsed,
  and full date-times give a publication date.
- Author sort (`file-as`) is read but not stored, and series isn't read.
