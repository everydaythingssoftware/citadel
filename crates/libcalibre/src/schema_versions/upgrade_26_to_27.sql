-- Calibre's step from schema 26 to 27: page counts per book, a
-- rebuilt meta view and the "cali" application id. The unused books columns
-- it drops (flags, isbn, lccn) are handled in Rust, since dropping needs to
-- know which still exist.
CREATE TABLE books_pages_link (
    book INTEGER PRIMARY KEY,
    pages INTEGER DEFAULT 0 NOT NULL,
    algorithm INTEGER DEFAULT 0 NOT NULL,
    format TEXT DEFAULT '' NOT NULL COLLATE NOCASE,
    format_size INTEGER DEFAULT 0 NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    needs_scan INTEGER NOT NULL DEFAULT 0 CHECK(needs_scan IN (0, 1)),
    FOREIGN KEY (book) REFERENCES books(id) ON DELETE CASCADE
);
CREATE TRIGGER books_pages_link_create_trigger AFTER INSERT ON books FOR EACH ROW
BEGIN
    INSERT INTO books_pages_link(book) VALUES(NEW.id);
END;
CREATE INDEX books_pages_link_pidx ON books_pages_link (needs_scan);
INSERT INTO books_pages_link(book,needs_scan) SELECT id,1 FROM books;

DROP VIEW meta;
CREATE VIEW meta AS
        SELECT id, title,
            (SELECT sortconcat(bal.id, name) FROM books_authors_link AS bal JOIN authors ON(author = authors.id) WHERE book = books.id) authors,
            (SELECT name FROM publishers WHERE publishers.id IN (SELECT publisher from books_publishers_link WHERE book=books.id)) publisher,
            (SELECT rating FROM ratings WHERE ratings.id IN (SELECT rating from books_ratings_link WHERE book=books.id)) rating,
            timestamp,
            (SELECT MAX(uncompressed_size) FROM data WHERE book=books.id) size,
            (SELECT concat(name) FROM tags WHERE tags.id IN (SELECT tag from books_tags_link WHERE book=books.id)) tags,
            (SELECT text FROM comments WHERE book=books.id) comments,
            (SELECT name FROM series WHERE series.id IN (SELECT series FROM books_series_link WHERE book=books.id)) series,
            series_index,
            sort,
            author_sort,
            (SELECT concat(format) FROM data WHERE data.book=books.id) formats,
            path,
            pubdate,
            uuid
        FROM books;

PRAGMA application_id = 0x63616c69;
