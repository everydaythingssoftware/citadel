-- One normalized custom column: text, series, enumeration or rating. Values
-- live once in custom_column_{n} and books attach to them through
-- books_custom_column_{n}_link.
--
-- Placeholders, filled by plain string replacement:
--   {n}            the custom_columns.id of this column
--   {value_type}   SQL type of the value column (TEXT, or INT for ratings)
--   {collate}      COLLATE NOCASE for text values, otherwise empty
--   {series_extra} `extra REAL,` for series columns (the series index),
--                  otherwise empty
--
-- The filtered tag-browser view needs books_list_filter(book) at query time.

CREATE TABLE IF NOT EXISTS custom_column_{n} (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    value {value_type} NOT NULL {collate},
    link  TEXT NOT NULL DEFAULT '',
    UNIQUE (value)
);
CREATE INDEX IF NOT EXISTS custom_column_{n}_idx ON custom_column_{n} (value);

CREATE TABLE IF NOT EXISTS books_custom_column_{n}_link (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    book  INTEGER NOT NULL,
    value INTEGER NOT NULL,
    {series_extra}
    UNIQUE (book, value)
);
CREATE INDEX IF NOT EXISTS books_custom_column_{n}_link_aidx ON books_custom_column_{n}_link (value);
CREATE INDEX IF NOT EXISTS books_custom_column_{n}_link_bidx ON books_custom_column_{n}_link (book);

CREATE TRIGGER IF NOT EXISTS fkc_insert_books_custom_column_{n}_link
BEFORE INSERT ON books_custom_column_{n}_link
BEGIN
    SELECT RAISE(ABORT, 'books_custom_column_{n}_link.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
    SELECT RAISE(ABORT, 'books_custom_column_{n}_link.value does not name an existing value')
     WHERE NOT EXISTS (SELECT 1 FROM custom_column_{n} WHERE id = NEW.value);
END;

CREATE TRIGGER IF NOT EXISTS fkc_update_books_custom_column_{n}_link_a
BEFORE UPDATE OF book ON books_custom_column_{n}_link
BEGIN
    SELECT RAISE(ABORT, 'books_custom_column_{n}_link.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

-- Calibre declares this trigger on a column named `author`, which the link
-- table does not have, so it never fires. The name and event are kept so the
-- catalogue matches Calibre's; updates of `value` are not validated.
CREATE TRIGGER IF NOT EXISTS fkc_update_books_custom_column_{n}_link_b
BEFORE UPDATE OF author ON books_custom_column_{n}_link
BEGIN
    SELECT RAISE(ABORT, 'books_custom_column_{n}_link.value does not name an existing value')
     WHERE NOT EXISTS (SELECT 1 FROM custom_column_{n} WHERE id = NEW.value);
END;

CREATE TRIGGER IF NOT EXISTS fkc_delete_books_custom_column_{n}_link
AFTER DELETE ON custom_column_{n}
BEGIN
    DELETE FROM books_custom_column_{n}_link WHERE value = OLD.id;
END;

DROP VIEW IF EXISTS tag_browser_custom_column_{n};
CREATE VIEW tag_browser_custom_column_{n} AS
SELECT
    c.id AS id,
    c.value AS value,
    (SELECT count(l.id)
       FROM books_custom_column_{n}_link AS l
      WHERE l.value = c.id) AS count,
    (SELECT avg(r.rating)
       FROM books_custom_column_{n}_link AS l
       JOIN books_ratings_link AS rl ON rl.book = l.book
       JOIN ratings AS r ON r.id = rl.rating
      WHERE l.value = c.id AND r.rating <> 0) AS avg_rating,
    c.value AS sort
FROM custom_column_{n} AS c;

DROP VIEW IF EXISTS tag_browser_filtered_custom_column_{n};
CREATE VIEW tag_browser_filtered_custom_column_{n} AS
SELECT
    c.id AS id,
    c.value AS value,
    (SELECT count(l.id)
       FROM books_custom_column_{n}_link AS l
      WHERE l.value = c.id AND books_list_filter(l.book)) AS count,
    (SELECT avg(r.rating)
       FROM books_custom_column_{n}_link AS l
       JOIN books_ratings_link AS rl ON rl.book = l.book
       JOIN ratings AS r ON r.id = rl.rating
      WHERE l.value = c.id AND r.rating <> 0 AND books_list_filter(l.book)) AS avg_rating,
    c.value AS sort
FROM custom_column_{n} AS c;
