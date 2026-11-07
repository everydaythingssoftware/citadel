-- Schema version 26 to 27: per-book page counts, and the books columns
-- isbn, lccn and flags retired (with the meta view that showed them).

CREATE TABLE books_pages_link (
    book        INTEGER PRIMARY KEY REFERENCES books (id) ON DELETE CASCADE,
    pages       INTEGER NOT NULL DEFAULT 0,
    algorithm   INTEGER NOT NULL DEFAULT 0,
    format      TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
    format_size INTEGER NOT NULL DEFAULT 0,
    timestamp   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    needs_scan  INTEGER NOT NULL DEFAULT 0 CHECK (needs_scan IN (0, 1))
);

CREATE INDEX books_pages_link_pidx ON books_pages_link (needs_scan);

CREATE TRIGGER books_pages_link_create_trigger
AFTER INSERT ON books
BEGIN
    INSERT INTO books_pages_link (book) VALUES (NEW.id);
END;

-- Every existing book gets a page-count row, marked for counting.
INSERT INTO books_pages_link (book, needs_scan) SELECT id, 1 FROM books;

DROP VIEW meta;
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

ALTER TABLE books DROP COLUMN isbn;
ALTER TABLE books DROP COLUMN lccn;
ALTER TABLE books DROP COLUMN flags;

-- "cali": marks the file as a Calibre library.
PRAGMA application_id = 1667329129;
