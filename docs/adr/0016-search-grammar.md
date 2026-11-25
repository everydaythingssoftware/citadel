# 16. Search grammar is a subset of the Calibre search language

Status: Accepted - 2026-11-27.

## Context

The search box matched a substring in the title, the author names and the series name. Users could not find a book by tag, publisher or identifier. They could not limit a term to one field. Citadel can later import the saved searches of Calibre. Those searches use the Calibre search language. A private grammar makes that import harder.

The desktop app, the web app and OPDS search use one parser in libcalibre. A smart shelf stores a search text and a scope, and the apps run it. The grammar must give the same books in each of them.

## Decision

1. **The grammar is a subset of the Calibre search language, with the Calibre field names.** It has bare words, quoted phrases, `field:value`, `=`, `true`, `false`, `and`, `or`, `not` and parentheses. The fields are `title`, `authors`, `series`, `tags`, `publisher`, `comments`, `identifiers`, `isbn`, `formats` and `languages`. A later import of Calibre saved searches can use the same parser.

   The structure of a search is:

   ```text
   or_expr  = and_expr { "or" and_expr }
   and_expr = not_expr { [ "and" ] not_expr }
   not_expr = "not" not_expr | primary
   primary  = "(" or_expr ")" | phrase | word [ adjacent phrase ]
   ```

   An adjacent phrase is a quoted phrase with no space before it. It continues a field value that is empty or `=`, for example in `title:"The Ring"` and `title:="The Ring"`. It also continues an identifiers value that ends with `:` or `:=`, and a bare `=`. After another word, the phrase is a separate term, thus `title:the"ring"` has two terms.
2. **A prefix that is not a supported field name is text.** A pasted title such as `Star Wars: A New Hope` or `Marked: A House of Night Novel` must find the book. Thus `Wars:` and `Marked:` are plain text. A word such as `titel:dune` is plain text too, and the result carries the hint `UnknownField`. A prefix with no value gets the same hint when it is one edit from a field name or an alias. Only a name of four or more letters counts, for example `title` in `titel: dune`. The query runs. A supported field name with no value, for example `title: dune` or `tags:`, gives `MissingValue`.
3. **A Calibre field or search kind that the grammar cannot apply is an error.** `rating:>=4`, `#genre:x` and `tags:~fan` give `UnsupportedField` or `UnsupportedSearchKind`. A silent text search for them gives wrong results with no warning. A `#` prefix is a custom column only when an ASCII letter follows the `#`. Thus `#1:x` is text with the hint `UnknownField`, but `#genre:x` gives `UnsupportedField`.
4. **A query never runs with part of the text.** Each search error, also an unsupported field or search kind, gives `CalibreError::InvalidSearch`. The query does not run. When only the search text or the scope changes, the grid keeps its last results. A callout under the search field gives the reason. OPDS gives a feed with no entries and the reason in its title, because an e-reader shows the title of a feed.
5. **A bare word has two scopes.** The `TitlesAuthorsSeries` scope, the default, searches the title, the authors and the series. The `AllFields` scope also searches tags, publisher and identifier values. `BookQuery::search_scope` selects the scope, and a field prefix works the same in both scopes.

   The desktop and web apps have a scope menu with the items "Titles, Authors & Series" and "All Fields". A saved shelf stores the scope. OPDS search always uses `AllFields`, because an e-reader has no scope menu.

The SQL for a linked field is a correlated `EXISTS`. We measured a non-correlated `books.id IN (SELECT ...)` and rejected it. The non-correlated form must build each full set before the page query can stop after 100 rows. A common word became about three times slower.

The lexer uses `logos`, and the parser uses `chumsky`. The grammar is then a short declaration that a reviewer can compare with this record. Each error and each hint carries the byte range of its text, which a later underline in the search field and autocomplete need. We compared a hand-written lexer and parser against this pair, and both gave the same results on a million random texts.

## Consequences

- The desktop app, the web app, OPDS search and the smart shelves give the same books for the same text and the same scope.
- A multi-word query is now an AND of words. A quoted phrase gives the old behavior. The settings migration to version 5 puts the query of each shelf saved before this decision in quotes, so the shelf finds the same books.
- A bare quoted phrase is always plain text, also when it starts with `=`, `~` or `^`. The settings migration depends on this rule. Calibre reads the first character of a bare phrase as a search kind. Thus an import of Calibre saved searches must change `"=Frank Herbert"` to `="Frank Herbert"`, and must refuse `"~x"` and `"^x"`. The form `="Frank Herbert"` is Citadel's own: Calibre reads it as the word `=` and a phrase.
- A query that starts with `not`, for example `not a penny more`, negates a term. A query that starts with `and` or `or`, for example `and then there were none`, gives `MissingTerm`. The user must quote the title.
- A pasted title that starts with a field name and a colon, for example `Language: The Cultural Tool`, gives `MissingValue`. The user must quote the title.
- The case folding stays ASCII only. Unicode folding is a later change.
- The parser limits a query to 100 terms and to 16 levels of parentheses and `not`. Before version 3.46, SQLite has a parser stack of 100 entries, and the SQL of a search with 25 levels overflows it. macOS and Debian 12 ship such a version. A search text has a maximum of 20,000 bytes, so that a LIKE pattern stays below the SQLite limit.
- In the default scope, the time of a search is 0.95 to 0.98 times the time of the old search. This difference is smaller than the difference between two runs of the same build. We measured this on a library of 12000 books, with the `logos` lexer and the `chumsky` parser. The `AllFields` scope checks six fields for each bare word.
- Citadel can add regular expressions, ratings, dates, custom columns and the other Calibre search kinds later, one at a time. Each addition keeps the rules above.
