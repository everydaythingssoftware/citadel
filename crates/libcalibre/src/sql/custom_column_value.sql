-- One per-book (non-normalized) custom column: bool, int, float, datetime,
-- comments or composite. Each book has at most one row; clearing a value
-- deletes the row.
--
-- Placeholders, filled by plain string replacement:
--   {n}          the custom_columns.id of this column
--   {value_type} SQL type of the value column (BOOL, INT, REAL, timestamp, TEXT)
--   {collate}    COLLATE NOCASE for comments/composite, otherwise empty

CREATE TABLE IF NOT EXISTS custom_column_{n} (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    book  INTEGER,
    value {value_type} NOT NULL {collate},
    UNIQUE (book)
);
CREATE INDEX IF NOT EXISTS custom_column_{n}_idx ON custom_column_{n} (book);

CREATE TRIGGER IF NOT EXISTS fkc_insert_custom_column_{n}
BEFORE INSERT ON custom_column_{n}
BEGIN
    SELECT RAISE(ABORT, 'custom_column_{n}.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;

CREATE TRIGGER IF NOT EXISTS fkc_update_custom_column_{n}
BEFORE UPDATE OF book ON custom_column_{n}
BEGIN
    SELECT RAISE(ABORT, 'custom_column_{n}.book does not name an existing book')
     WHERE NOT EXISTS (SELECT 1 FROM books WHERE id = NEW.book);
END;
