-- Main metadata store of a Calibre library, schema version 28.
--
-- Safe to run repeatedly and against older libraries: every table, index and
-- trigger is created only when missing, and every view is replaced. The caller
-- sets user_version, application_id and the library_id row, and registers the
-- SQL functions title_sort(text) and uuid4() used by the triggers below. The
-- filtered tag-browser views additionally need books_list_filter(book) at query
-- time.

-- ---------------------------------------------------------------------------
-- Books
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS books (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL DEFAULT 'Unknown' COLLATE NOCASE,
    sort          TEXT COLLATE NOCASE,
    timestamp     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    pubdate       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    series_index  REAL NOT NULL DEFAULT 1.0,
    author_sort   TEXT COLLATE NOCASE,
    path          TEXT NOT NULL DEFAULT '',
    uuid          TEXT,
    has_cover     BOOL DEFAULT 0,
    last_modified TIMESTAMP NOT NULL DEFAULT '2000-01-01 00:00:00+00:00'
);
CREATE INDEX IF NOT EXISTS authors_idx ON books (author_sort COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS books_idx ON books (sort COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS books_pages_link (
    book        INTEGER PRIMARY KEY REFERENCES books (id) ON DELETE CASCADE,
    pages       INTEGER NOT NULL DEFAULT 0,
    algorithm   INTEGER NOT NULL DEFAULT 0,
    format      TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
    format_size INTEGER NOT NULL DEFAULT 0,
    timestamp   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    needs_scan  INTEGER NOT NULL DEFAULT 0 CHECK (needs_scan IN (0, 1))
);
CREATE INDEX IF NOT EXISTS books_pages_link_pidx ON books_pages_link (needs_scan);

CREATE TABLE IF NOT EXISTS comments (
    id   INTEGER PRIMARY KEY,
    book INTEGER NOT NULL UNIQUE,
    text TEXT NOT NULL COLLATE NOCASE
);
CREATE INDEX IF NOT EXISTS comments_idx ON comments (book);

CREATE TABLE IF NOT EXISTS data (
    id                INTEGER PRIMARY KEY,
    book              INTEGER NOT NULL,
    format            TEXT NOT NULL COLLATE NOCASE,
    uncompressed_size INTEGER NOT NULL,
    name              TEXT NOT NULL,
    UNIQUE (book, format)
);
CREATE INDEX IF NOT EXISTS data_idx ON data (book);
CREATE INDEX IF NOT EXISTS formats_idx ON data (format COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS identifiers (
    id   INTEGER PRIMARY KEY,
    book INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'isbn' COLLATE NOCASE,
    val  TEXT NOT NULL COLLATE NOCASE,
    UNIQUE (book, type)
);

CREATE TABLE IF NOT EXISTS conversion_options (
    id     INTEGER PRIMARY KEY,
    format TEXT NOT NULL COLLATE NOCASE,
    book   INTEGER,
    data   BLOB NOT NULL,
    UNIQUE (format, book)
);
CREATE INDEX IF NOT EXISTS conversion_options_idx_a ON conversion_options (format COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS conversion_options_idx_b ON conversion_options (book);

CREATE TABLE IF NOT EXISTS books_plugin_data (
    id   INTEGER PRIMARY KEY,
    book INTEGER NOT NULL,
    name TEXT NOT NULL,
    val  TEXT NOT NULL,
    UNIQUE (book, name)
);

CREATE TABLE IF NOT EXISTS metadata_dirtied (
    id   INTEGER PRIMARY KEY,
    book INTEGER NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS annotations_dirtied (
    id   INTEGER PRIMARY KEY,
    book INTEGER NOT NULL UNIQUE
);

-- ---------------------------------------------------------------------------
-- Reading state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS last_read_positions (
    id       INTEGER PRIMARY KEY,
    book     INTEGER NOT NULL,
    format   TEXT NOT NULL COLLATE NOCASE,
    user     TEXT NOT NULL,
    device   TEXT NOT NULL,
    cfi      TEXT NOT NULL,
    epoch    REAL NOT NULL,
    pos_frac REAL NOT NULL DEFAULT 0,
    UNIQUE (user, device, book, format)
);
CREATE INDEX IF NOT EXISTS lrp_idx ON last_read_positions (book);

CREATE TABLE IF NOT EXISTS annotations (
    id              INTEGER PRIMARY KEY,
    book            INTEGER NOT NULL,
    format          TEXT NOT NULL COLLATE NOCASE,
    user_type       TEXT NOT NULL,
    user            TEXT NOT NULL,
    timestamp       REAL NOT NULL,
    annot_id        TEXT NOT NULL,
    annot_type      TEXT NOT NULL,
    annot_data      TEXT NOT NULL,
    searchable_text TEXT NOT NULL DEFAULT '',
    UNIQUE (book, user_type, user, format, annot_type, annot_id)
);
CREATE INDEX IF NOT EXISTS annot_idx ON annotations (book);

CREATE VIRTUAL TABLE IF NOT EXISTS annotations_fts USING fts5 (
    searchable_text,
    content = 'annotations',
    content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS annotations_fts_stemmed USING fts5 (
    searchable_text,
    content = 'annotations',
    content_rowid = 'id',
    tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS book_storage (
    id        INTEGER PRIMARY KEY,
    book      INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    format    TEXT NOT NULL COLLATE NOCASE,
    user_type TEXT NOT NULL,
    user      TEXT NOT NULL,
    timestamp REAL NOT NULL,
    data      TEXT NOT NULL DEFAULT '{}',
    UNIQUE (book, format, user_type, user)
);

-- ---------------------------------------------------------------------------
-- Categories and their book links
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS authors (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sort TEXT COLLATE NOCASE,
    link TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS books_authors_link (
    id     INTEGER PRIMARY KEY,
    book   INTEGER NOT NULL,
    author INTEGER NOT NULL,
    UNIQUE (book, author)
);
CREATE INDEX IF NOT EXISTS books_authors_link_aidx ON books_authors_link (author);
CREATE INDEX IF NOT EXISTS books_authors_link_bidx ON books_authors_link (book);

CREATE TABLE IF NOT EXISTS languages (
    id        INTEGER PRIMARY KEY,
    lang_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    link      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS languages_idx ON languages (lang_code COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS books_languages_link (
    id         INTEGER PRIMARY KEY,
    book       INTEGER NOT NULL,
    lang_code  INTEGER NOT NULL,
    item_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (book, lang_code)
);
CREATE INDEX IF NOT EXISTS books_languages_link_aidx ON books_languages_link (lang_code);
CREATE INDEX IF NOT EXISTS books_languages_link_bidx ON books_languages_link (book);

CREATE TABLE IF NOT EXISTS publishers (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sort TEXT COLLATE NOCASE,
    link TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS publishers_idx ON publishers (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS books_publishers_link (
    id        INTEGER PRIMARY KEY,
    book      INTEGER NOT NULL UNIQUE,
    publisher INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS books_publishers_link_aidx ON books_publishers_link (publisher);
CREATE INDEX IF NOT EXISTS books_publishers_link_bidx ON books_publishers_link (book);

CREATE TABLE IF NOT EXISTS ratings (
    id     INTEGER PRIMARY KEY,
    rating INTEGER UNIQUE CHECK (rating > -1 AND rating < 11),
    link   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS books_ratings_link (
    id     INTEGER PRIMARY KEY,
    book   INTEGER NOT NULL,
    rating INTEGER NOT NULL,
    UNIQUE (book, rating)
);
CREATE INDEX IF NOT EXISTS books_ratings_link_aidx ON books_ratings_link (rating);
CREATE INDEX IF NOT EXISTS books_ratings_link_bidx ON books_ratings_link (book);

CREATE TABLE IF NOT EXISTS series (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sort TEXT COLLATE NOCASE,
    link TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS series_idx ON series (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS books_series_link (
    id     INTEGER PRIMARY KEY,
    book   INTEGER NOT NULL UNIQUE,
    series INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS books_series_link_aidx ON books_series_link (series);
CREATE INDEX IF NOT EXISTS books_series_link_bidx ON books_series_link (book);

CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    link TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tags_idx ON tags (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS books_tags_link (
    id   INTEGER PRIMARY KEY,
    book INTEGER NOT NULL,
    tag  INTEGER NOT NULL,
    UNIQUE (book, tag)
);
CREATE INDEX IF NOT EXISTS books_tags_link_aidx ON books_tags_link (tag);
CREATE INDEX IF NOT EXISTS books_tags_link_bidx ON books_tags_link (book);

-- ---------------------------------------------------------------------------
-- Library-wide tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS custom_columns (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    label           TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    datatype        TEXT NOT NULL,
    mark_for_delete BOOL NOT NULL DEFAULT 0,
    editable        BOOL NOT NULL DEFAULT 1,
    display         TEXT NOT NULL DEFAULT '{}',
    is_multiple     BOOL NOT NULL DEFAULT 0,
    normalized      BOOL NOT NULL
);
CREATE INDEX IF NOT EXISTS custom_columns_idx ON custom_columns (label);

CREATE TABLE IF NOT EXISTS feeds (
    id     INTEGER PRIMARY KEY,
    title  TEXT NOT NULL UNIQUE,
    script TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS library_id (
    id   INTEGER PRIMARY KEY,
    uuid TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS preferences (
    id  INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    val TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Book triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS books_insert_trg
AFTER INSERT ON books
BEGIN
    UPDATE books
       SET sort = title_sort(NEW.title),
           uuid = uuid4()
     WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS books_pages_link_create_trigger
AFTER INSERT ON books
BEGIN
    INSERT INTO books_pages_link (book) VALUES (NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS books_update_trg
AFTER UPDATE ON books
BEGIN
    UPDATE books
       SET sort = title_sort(NEW.title)
     WHERE id = NEW.id
       AND OLD.title <> NEW.title;
END;

CREATE TRIGGER IF NOT EXISTS books_delete_trg
AFTER DELETE ON books
BEGIN
    DELETE FROM books_authors_link    WHERE book = OLD.id;
    DELETE FROM books_publishers_link WHERE book = OLD.id;
    DELETE FROM books_ratings_link    WHERE book = OLD.id;
    DELETE FROM books_series_link     WHERE book = OLD.id;
    DELETE FROM books_tags_link       WHERE book = OLD.id;
    DELETE FROM books_languages_link  WHERE book = OLD.id;
    DELETE FROM data                  WHERE book = OLD.id;
    DELETE FROM last_read_positions   WHERE book = OLD.id;
    DELETE FROM annotations           WHERE book = OLD.id;
    DELETE FROM comments              WHERE book = OLD.id;
    DELETE FROM conversion_options    WHERE book = OLD.id;
    DELETE FROM books_plugin_data     WHERE book = OLD.id;
    DELETE FROM identifiers           WHERE book = OLD.id;
END;

-- ---------------------------------------------------------------------------
-- Book-owned rows must point at an existing book
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS fkc_comments_insert
BEFORE INSERT ON comments
BEGIN
    SELECT RAISE(ABORT, 'comments.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

CREATE TRIGGER IF NOT EXISTS fkc_comments_update
BEFORE UPDATE OF book ON comments
BEGIN
    SELECT RAISE(ABORT, 'comments.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

CREATE TRIGGER IF NOT EXISTS fkc_data_insert
BEFORE INSERT ON data
BEGIN
    SELECT RAISE(ABORT, 'data.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

CREATE TRIGGER IF NOT EXISTS fkc_data_update
BEFORE UPDATE OF book ON data
BEGIN
    SELECT RAISE(ABORT, 'data.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

CREATE TRIGGER IF NOT EXISTS fkc_lrp_insert
BEFORE INSERT ON last_read_positions
BEGIN
    SELECT RAISE(ABORT, 'last_read_positions.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

CREATE TRIGGER IF NOT EXISTS fkc_lrp_update
BEFORE UPDATE OF book ON last_read_positions
BEGIN
    SELECT RAISE(ABORT, 'last_read_positions.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

CREATE TRIGGER IF NOT EXISTS fkc_annot_insert
BEFORE INSERT ON annotations
BEGIN
    SELECT RAISE(ABORT, 'annotations.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

CREATE TRIGGER IF NOT EXISTS fkc_annot_update
BEFORE UPDATE OF book ON annotations
BEGIN
    SELECT RAISE(ABORT, 'annotations.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

-- ---------------------------------------------------------------------------
-- Category links must point at an existing book and category row
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS fkc_insert_books_authors_link
BEFORE INSERT ON books_authors_link
BEGIN
    SELECT RAISE(ABORT, 'books_authors_link.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
    SELECT RAISE(ABORT, 'books_authors_link.author does not name an existing author')
     WHERE NOT EXISTS (SELECT 1 FROM authors WHERE id = NEW.author);
END;

CREATE TRIGGER IF NOT EXISTS fkc_update_books_authors_link_a
BEFORE UPDATE OF book ON books_authors_link
BEGIN
    SELECT RAISE(ABORT, 'books_authors_link.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

CREATE TRIGGER IF NOT EXISTS fkc_update_books_authors_link_b
BEFORE UPDATE OF author ON books_authors_link
BEGIN
    SELECT RAISE(ABORT, 'books_authors_link.author does not name an existing author')
     WHERE NOT EXISTS (SELECT 1 FROM authors WHERE id = NEW.author);
END;

CREATE TRIGGER IF NOT EXISTS fkc_delete_on_languages_link
BEFORE INSERT ON books_languages_link
BEGIN
    SELECT RAISE(ABORT, 'books_languages_link.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
    SELECT RAISE(ABORT, 'books_languages_link.lang_code does not name an existing language')
     WHERE NOT EXISTS (SELECT 1 FROM languages WHERE id = NEW.lang_code);
END;

CREATE TRIGGER IF NOT EXISTS fkc_update_books_languages_link_a
BEFORE UPDATE OF book ON books_languages_link
BEGIN
    SELECT RAISE(ABORT, 'books_languages_link.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

CREATE TRIGGER IF NOT EXISTS fkc_update_books_languages_link_b
BEFORE UPDATE OF lang_code ON books_languages_link
BEGIN
    SELECT RAISE(ABORT, 'books_languages_link.lang_code does not name an existing language')
     WHERE NOT EXISTS (SELECT 1 FROM languages WHERE id = NEW.lang_code);
END;

CREATE TRIGGER IF NOT EXISTS fkc_insert_books_publishers_link
BEFORE INSERT ON books_publishers_link
BEGIN
    SELECT RAISE(ABORT, 'books_publishers_link.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
    SELECT RAISE(ABORT, 'books_publishers_link.publisher does not name an existing publisher')
     WHERE NOT EXISTS (SELECT 1 FROM publishers WHERE id = NEW.publisher);
END;

CREATE TRIGGER IF NOT EXISTS fkc_update_books_publishers_link_a
BEFORE UPDATE OF book ON books_publishers_link
BEGIN
    SELECT RAISE(ABORT, 'books_publishers_link.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

CREATE TRIGGER IF NOT EXISTS fkc_update_books_publishers_link_b
BEFORE UPDATE OF publisher ON books_publishers_link
BEGIN
    SELECT RAISE(ABORT, 'books_publishers_link.publisher does not name an existing publisher')
     WHERE NOT EXISTS (SELECT 1 FROM publishers WHERE id = NEW.publisher);
END;

CREATE TRIGGER IF NOT EXISTS fkc_insert_books_ratings_link
BEFORE INSERT ON books_ratings_link
BEGIN
    SELECT RAISE(ABORT, 'books_ratings_link.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
    SELECT RAISE(ABORT, 'books_ratings_link.rating does not name an existing rating')
     WHERE NOT EXISTS (SELECT 1 FROM ratings WHERE id = NEW.rating);
END;

CREATE TRIGGER IF NOT EXISTS fkc_update_books_ratings_link_a
BEFORE UPDATE OF book ON books_ratings_link
BEGIN
    SELECT RAISE(ABORT, 'books_ratings_link.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

CREATE TRIGGER IF NOT EXISTS fkc_update_books_ratings_link_b
BEFORE UPDATE OF rating ON books_ratings_link
BEGIN
    SELECT RAISE(ABORT, 'books_ratings_link.rating does not name an existing rating')
     WHERE NOT EXISTS (SELECT 1 FROM ratings WHERE id = NEW.rating);
END;

CREATE TRIGGER IF NOT EXISTS fkc_insert_books_series_link
BEFORE INSERT ON books_series_link
BEGIN
    SELECT RAISE(ABORT, 'books_series_link.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
    SELECT RAISE(ABORT, 'books_series_link.series does not name an existing series')
     WHERE NOT EXISTS (SELECT 1 FROM series WHERE id = NEW.series);
END;

CREATE TRIGGER IF NOT EXISTS fkc_update_books_series_link_a
BEFORE UPDATE OF book ON books_series_link
BEGIN
    SELECT RAISE(ABORT, 'books_series_link.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

CREATE TRIGGER IF NOT EXISTS fkc_update_books_series_link_b
BEFORE UPDATE OF series ON books_series_link
BEGIN
    SELECT RAISE(ABORT, 'books_series_link.series does not name an existing series')
     WHERE NOT EXISTS (SELECT 1 FROM series WHERE id = NEW.series);
END;

CREATE TRIGGER IF NOT EXISTS fkc_insert_books_tags_link
BEFORE INSERT ON books_tags_link
BEGIN
    SELECT RAISE(ABORT, 'books_tags_link.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
    SELECT RAISE(ABORT, 'books_tags_link.tag does not name an existing tag')
     WHERE NOT EXISTS (SELECT 1 FROM tags WHERE id = NEW.tag);
END;

CREATE TRIGGER IF NOT EXISTS fkc_update_books_tags_link_a
BEFORE UPDATE OF book ON books_tags_link
BEGIN
    SELECT RAISE(ABORT, 'books_tags_link.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

CREATE TRIGGER IF NOT EXISTS fkc_update_books_tags_link_b
BEFORE UPDATE OF tag ON books_tags_link
BEGIN
    SELECT RAISE(ABORT, 'books_tags_link.tag does not name an existing tag')
     WHERE NOT EXISTS (SELECT 1 FROM tags WHERE id = NEW.tag);
END;

-- ---------------------------------------------------------------------------
-- Category rows cannot be deleted while a book still links to them
-- (ratings have no such guard)
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS fkc_delete_on_authors
BEFORE DELETE ON authors
BEGIN
    SELECT RAISE(ABORT, 'author is still linked to a book')
     WHERE EXISTS (SELECT 1 FROM books_authors_link WHERE author = OLD.id);
END;

CREATE TRIGGER IF NOT EXISTS fkc_delete_on_languages
BEFORE DELETE ON languages
BEGIN
    SELECT RAISE(ABORT, 'language is still linked to a book')
     WHERE EXISTS (SELECT 1 FROM books_languages_link WHERE lang_code = OLD.id);
END;

CREATE TRIGGER IF NOT EXISTS fkc_delete_on_publishers
BEFORE DELETE ON publishers
BEGIN
    SELECT RAISE(ABORT, 'publisher is still linked to a book')
     WHERE EXISTS (SELECT 1 FROM books_publishers_link WHERE publisher = OLD.id);
END;

CREATE TRIGGER IF NOT EXISTS fkc_delete_on_series
BEFORE DELETE ON series
BEGIN
    SELECT RAISE(ABORT, 'series is still linked to a book')
     WHERE EXISTS (SELECT 1 FROM books_series_link WHERE series = OLD.id);
END;

CREATE TRIGGER IF NOT EXISTS fkc_delete_on_tags
BEFORE DELETE ON tags
BEGIN
    SELECT RAISE(ABORT, 'tag is still linked to a book')
     WHERE EXISTS (SELECT 1 FROM books_tags_link WHERE tag = OLD.id);
END;

-- ---------------------------------------------------------------------------
-- Series sort follows the series name
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS series_insert_trg
AFTER INSERT ON series
BEGIN
    UPDATE series SET sort = title_sort(NEW.name) WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS series_update_trg
AFTER UPDATE ON series
BEGIN
    UPDATE series SET sort = title_sort(NEW.name) WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------------
-- Annotation search indexes mirror annotations.searchable_text
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS annotations_fts_insert_trg
AFTER INSERT ON annotations
BEGIN
    INSERT INTO annotations_fts (rowid, searchable_text)
    VALUES (NEW.id, NEW.searchable_text);
    INSERT INTO annotations_fts_stemmed (rowid, searchable_text)
    VALUES (NEW.id, NEW.searchable_text);
END;

CREATE TRIGGER IF NOT EXISTS annotations_fts_delete_trg
AFTER DELETE ON annotations
BEGIN
    INSERT INTO annotations_fts (annotations_fts, rowid, searchable_text)
    VALUES ('delete', OLD.id, OLD.searchable_text);
    INSERT INTO annotations_fts_stemmed (annotations_fts_stemmed, rowid, searchable_text)
    VALUES ('delete', OLD.id, OLD.searchable_text);
END;

CREATE TRIGGER IF NOT EXISTS annotations_fts_update_trg
AFTER UPDATE ON annotations
BEGIN
    INSERT INTO annotations_fts (annotations_fts, rowid, searchable_text)
    VALUES ('delete', OLD.id, OLD.searchable_text);
    INSERT INTO annotations_fts_stemmed (annotations_fts_stemmed, rowid, searchable_text)
    VALUES ('delete', OLD.id, OLD.searchable_text);
    INSERT INTO annotations_fts (rowid, searchable_text)
    VALUES (NEW.id, NEW.searchable_text);
    INSERT INTO annotations_fts_stemmed (rowid, searchable_text)
    VALUES (NEW.id, NEW.searchable_text);
END;

-- ---------------------------------------------------------------------------
-- Legacy views
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS meta;
CREATE VIEW meta AS
SELECT
    b.id AS id,
    b.title AS title,
    (SELECT group_concat(ordered.name, ',')
       FROM (SELECT a.name AS name
               FROM books_authors_link AS l
               JOIN authors AS a ON a.id = l.author
              WHERE l.book = b.id
              ORDER BY l.id) AS ordered) AS authors,
    (SELECT p.name
       FROM books_publishers_link AS l
       JOIN publishers AS p ON p.id = l.publisher
      WHERE l.book = b.id) AS publisher,
    (SELECT r.rating
       FROM books_ratings_link AS l
       JOIN ratings AS r ON r.id = l.rating
      WHERE l.book = b.id) AS rating,
    b.timestamp AS timestamp,
    (SELECT max(d.uncompressed_size) FROM data AS d WHERE d.book = b.id) AS size,
    (SELECT group_concat(ordered.name, ',')
       FROM (SELECT t.name AS name
               FROM books_tags_link AS l
               JOIN tags AS t ON t.id = l.tag
              WHERE l.book = b.id
              ORDER BY l.id) AS ordered) AS tags,
    (SELECT c.text FROM comments AS c WHERE c.book = b.id) AS comments,
    (SELECT s.name
       FROM books_series_link AS l
       JOIN series AS s ON s.id = l.series
      WHERE l.book = b.id) AS series,
    b.series_index AS series_index,
    b.sort AS sort,
    b.author_sort AS author_sort,
    (SELECT group_concat(ordered.format, ',')
       FROM (SELECT d.format AS format
               FROM data AS d
              WHERE d.book = b.id
              ORDER BY d.id) AS ordered) AS formats,
    b.path AS path,
    b.pubdate AS pubdate,
    b.uuid AS uuid
FROM books AS b;

DROP VIEW IF EXISTS tag_browser_authors;
CREATE VIEW tag_browser_authors AS
SELECT
    c.id AS id,
    c.name AS name,
    (SELECT count(l.id) FROM books_authors_link AS l WHERE l.author = c.id) AS count,
    (SELECT avg(r.rating)
       FROM books_authors_link AS l
       JOIN books_ratings_link AS rl ON rl.book = l.book
       JOIN ratings AS r ON r.id = rl.rating
      WHERE l.author = c.id AND r.rating <> 0) AS avg_rating,
    c.sort AS sort
FROM authors AS c;

DROP VIEW IF EXISTS tag_browser_filtered_authors;
CREATE VIEW tag_browser_filtered_authors AS
SELECT
    c.id AS id,
    c.name AS name,
    (SELECT count(l.id)
       FROM books_authors_link AS l
      WHERE l.author = c.id AND books_list_filter(l.book)) AS count,
    (SELECT avg(r.rating)
       FROM books_authors_link AS l
       JOIN books_ratings_link AS rl ON rl.book = l.book
       JOIN ratings AS r ON r.id = rl.rating
      WHERE l.author = c.id AND r.rating <> 0 AND books_list_filter(l.book)) AS avg_rating,
    c.sort AS sort
FROM authors AS c;

DROP VIEW IF EXISTS tag_browser_publishers;
CREATE VIEW tag_browser_publishers AS
SELECT
    c.id AS id,
    c.name AS name,
    (SELECT count(l.id) FROM books_publishers_link AS l WHERE l.publisher = c.id) AS count,
    (SELECT avg(r.rating)
       FROM books_publishers_link AS l
       JOIN books_ratings_link AS rl ON rl.book = l.book
       JOIN ratings AS r ON r.id = rl.rating
      WHERE l.publisher = c.id AND r.rating <> 0) AS avg_rating,
    c.name AS sort
FROM publishers AS c;

DROP VIEW IF EXISTS tag_browser_filtered_publishers;
CREATE VIEW tag_browser_filtered_publishers AS
SELECT
    c.id AS id,
    c.name AS name,
    (SELECT count(l.id)
       FROM books_publishers_link AS l
      WHERE l.publisher = c.id AND books_list_filter(l.book)) AS count,
    (SELECT avg(r.rating)
       FROM books_publishers_link AS l
       JOIN books_ratings_link AS rl ON rl.book = l.book
       JOIN ratings AS r ON r.id = rl.rating
      WHERE l.publisher = c.id AND r.rating <> 0 AND books_list_filter(l.book)) AS avg_rating,
    c.name AS sort
FROM publishers AS c;

DROP VIEW IF EXISTS tag_browser_ratings;
CREATE VIEW tag_browser_ratings AS
SELECT
    c.id AS id,
    c.rating AS rating,
    (SELECT count(l.id) FROM books_ratings_link AS l WHERE l.rating = c.id) AS count,
    (SELECT avg(r.rating)
       FROM books_ratings_link AS l
       JOIN books_ratings_link AS rl ON rl.book = l.book
       JOIN ratings AS r ON r.id = rl.rating
      WHERE l.rating = c.id AND r.rating <> 0) AS avg_rating,
    c.rating AS sort
FROM ratings AS c;

DROP VIEW IF EXISTS tag_browser_filtered_ratings;
CREATE VIEW tag_browser_filtered_ratings AS
SELECT
    c.id AS id,
    c.rating AS rating,
    (SELECT count(l.id)
       FROM books_ratings_link AS l
      WHERE l.rating = c.id AND books_list_filter(l.book)) AS count,
    (SELECT avg(r.rating)
       FROM books_ratings_link AS l
       JOIN books_ratings_link AS rl ON rl.book = l.book
       JOIN ratings AS r ON r.id = rl.rating
      WHERE l.rating = c.id AND r.rating <> 0 AND books_list_filter(l.book)) AS avg_rating,
    c.rating AS sort
FROM ratings AS c;

DROP VIEW IF EXISTS tag_browser_series;
CREATE VIEW tag_browser_series AS
SELECT
    c.id AS id,
    c.name AS name,
    (SELECT count(l.id) FROM books_series_link AS l WHERE l.series = c.id) AS count,
    (SELECT avg(r.rating)
       FROM books_series_link AS l
       JOIN books_ratings_link AS rl ON rl.book = l.book
       JOIN ratings AS r ON r.id = rl.rating
      WHERE l.series = c.id AND r.rating <> 0) AS avg_rating,
    title_sort(c.name) AS sort
FROM series AS c;

DROP VIEW IF EXISTS tag_browser_filtered_series;
CREATE VIEW tag_browser_filtered_series AS
SELECT
    c.id AS id,
    c.name AS name,
    (SELECT count(l.id)
       FROM books_series_link AS l
      WHERE l.series = c.id AND books_list_filter(l.book)) AS count,
    (SELECT avg(r.rating)
       FROM books_series_link AS l
       JOIN books_ratings_link AS rl ON rl.book = l.book
       JOIN ratings AS r ON r.id = rl.rating
      WHERE l.series = c.id AND r.rating <> 0 AND books_list_filter(l.book)) AS avg_rating,
    title_sort(c.name) AS sort
FROM series AS c;

DROP VIEW IF EXISTS tag_browser_tags;
CREATE VIEW tag_browser_tags AS
SELECT
    c.id AS id,
    c.name AS name,
    (SELECT count(l.id) FROM books_tags_link AS l WHERE l.tag = c.id) AS count,
    (SELECT avg(r.rating)
       FROM books_tags_link AS l
       JOIN books_ratings_link AS rl ON rl.book = l.book
       JOIN ratings AS r ON r.id = rl.rating
      WHERE l.tag = c.id AND r.rating <> 0) AS avg_rating,
    c.name AS sort
FROM tags AS c;

DROP VIEW IF EXISTS tag_browser_filtered_tags;
CREATE VIEW tag_browser_filtered_tags AS
SELECT
    c.id AS id,
    c.name AS name,
    (SELECT count(l.id)
       FROM books_tags_link AS l
      WHERE l.tag = c.id AND books_list_filter(l.book)) AS count,
    (SELECT avg(r.rating)
       FROM books_tags_link AS l
       JOIN books_ratings_link AS rl ON rl.book = l.book
       JOIN ratings AS r ON r.id = rl.rating
      WHERE l.tag = c.id AND r.rating <> 0 AND books_list_filter(l.book)) AS avg_rating,
    c.name AS sort
FROM tags AS c;
