# 17. Search and name lookups fold the Unicode case

Status: Accepted - 2026-11-28

## Context

SQLite's `LIKE` and the `NOCASE` collation fold the case of ASCII letters only. libcalibre used them for the book search and for the lookups that find an existing tag, author, series, publisher or custom column value by name. Thus a lowercase Cyrillic or Greek word did not find a capitalized title, "l'étranger" did not find "L'Étranger", and "фэнтези" on a book added a second tag next to "Фэнтези".

Russian text has one more problem. The letter "ё" is optional in ordinary Russian writing, and most books and most metadata write "е" in its place. Thus a search for "всё" did not find a title that stores "все".

Calibre opens the same `metadata.db`. A fix must not change the schema, and must not put anything in it that Calibre cannot run.

## Decision

1. **The fold runs only in queries, and never in the schema.** libcalibre registers two Rust functions on each connection, `casefold` and `casefold_simple`. No trigger, view or index may use them, because Calibre does not have them. A test makes sure that no `sqlite_master` row refers to them. We rejected a replacement of SQLite's `like()`, because it changes every `LIKE` on the connection and does not help the `=` lookups. We also rejected a folded cache, because Calibre can change the library at any time.
2. **The fold changes the letter case only. Accents stay significant.** "garcía" finds "GARCÍA", but "garcia" does not find "García". This is the same as the default search of Calibre. An accent-insensitive search is Calibre's character variant search (`^`), which can come later as another query function.
3. **Both sides of a comparison are in NFC.** Each fold decomposes the text to NFD, folds the case, and composes the result to NFC. The NFD step follows the canonical caseless match of the Unicode standard. The comparison uses NFC and not NFD, because in NFD a search for "Rene" finds "René" and a search for "и" finds "й".
4. **"ё" folds to "е".** This is a difference from Calibre. The reason is that "ё" is optional in Russian writing. The rule applies to "ё" only, and "é" and "e" stay different.
5. **The search uses the full case folding, and the lookups use the simple case folding.** The search fold `casefold` makes "Straße" and "STRASSE" match. The lookup fold `casefold_simple` maps each character to one character, so it keeps them apart. A wrong search match shows one extra book. A wrong lookup match links a book to the wrong value with no warning, thus a lookup uses the narrower rule.
6. **A lookup runs its indexed query first.** Each lookup keeps its `COLLATE NOCASE` query, which finds an exact match or an ASCII case variant. Only when that query finds no row and the input has a non-ASCII character does the lookup scan with `casefold_simple`. Among the rows that fold to the same text, the lookup selects the lowest id. It never merges, renames or deletes a row.

## Consequences

- A lowercase word in any script finds a capitalized title, author name or series name. This is true in the desktop app, the web app, OPDS search and the smart shelves.
- "всё" and "все" find each other in the search, and a lookup for "ежик" links an existing "Ёжик".
- A search can find more books than before, thus a smart shelf can show more books than before.
- On a book, a user cannot add two tags, authors, series, publishers or custom column values that differ only in letter case, in any script. Libraries that already hold such pairs keep them. The authors page can still add an author that differs from an existing author only in non-ASCII case, because `Library::add_author` does no lookup.
- An ASCII input skips the folded lookup. Thus a stored value with a Kelvin sign (U+212A) does not match an ASCII "k".
- The default folding of Unicode applies, not the Turkic folding. Thus "istanbul" does not find "İstanbul".
- The sort order does not change. `ORDER BY ... COLLATE NOCASE` stays ASCII only.
- We measured `bench_library_queries` on libraries of 12000 books, with 7 runs. On an ASCII library, a text search takes 1.23 to 1.33 times the time of the old search, for example 9.7 ms against 7.3 ms for a common word. On a library where about a third of the titles are non-ASCII, a text search takes 1.62 to 1.84 times the old time, for example 16.9 ms against 9.2 ms for a common word, and 54.3 ms against 33.5 ms for a rare word. A search for the non-ASCII word "évasion" takes 44.9 ms, and a search for the Cyrillic word "озеро" takes 51.4 ms. Before the change, "évasion" found no book, so its old time of 32.3 ms is not a like-for-like comparison. Queries with no text do not change.
- A new non-ASCII name on a book scans its table with `casefold_simple`, so its cost grows with the size of the table. With 5,000 authors, an add with a new Cyrillic author takes 1.6 ms, against 0.4 ms with a new ASCII author. With 50,000 authors, it takes 10.9 ms. Thus an import of 1,000 books with new Cyrillic authors into such a library takes about 10 seconds more. A bulk add of the 12000-book stress library, with about 300 non-ASCII authors, takes the same time as before.
