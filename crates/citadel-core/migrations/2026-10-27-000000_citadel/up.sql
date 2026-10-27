CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT,
    app_password TEXT,
    created_at BIGINT NOT NULL
);

CREATE TABLE external_identities (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (issuer, subject)
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
);
CREATE INDEX sessions_user_id ON sessions(user_id);

-- id is the Calibre library UUID; path is where it was last opened.
CREATE TABLE libraries (
    id TEXT PRIMARY KEY NOT NULL,
    path TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE TABLE library_grants (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, library_id)
);
