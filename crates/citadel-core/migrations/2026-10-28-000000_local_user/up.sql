-- Installation-wide values, such as which user is the desktop's local user.
CREATE TABLE properties (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
