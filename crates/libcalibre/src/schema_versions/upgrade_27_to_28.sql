-- Calibre schema_upgrades.upgrade_version_27: per-book localStorage for the
-- viewers.
CREATE TABLE book_storage ( id INTEGER PRIMARY KEY,
    book INTEGER NOT NULL,
    format TEXT NOT NULL COLLATE NOCASE,
    user_type TEXT NOT NULL,
    user TEXT NOT NULL,
    timestamp REAL NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    UNIQUE(book, format, user_type, user),
    FOREIGN KEY (book) REFERENCES books(id) ON DELETE CASCADE
);
