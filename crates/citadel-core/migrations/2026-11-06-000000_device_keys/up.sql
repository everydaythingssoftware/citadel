-- OPDS device keys (ADR 0013): several per user, named, shown once and kept
-- only as a salted SHA-256 (`citadel_sha256_hex`, registered by the store
-- before migrating). key_hash = sha256(salt || key), both as lowercase hex.
CREATE TABLE device_keys (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    salt TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    last_used_at BIGINT,
    UNIQUE (user_id, name)
);

-- Each existing app password becomes one key, so readers already set up keep
-- signing in. A temporary table fixes each salt before it is used twice.
CREATE TEMP TABLE migrating_app_passwords AS
    SELECT id AS user_id, app_password, lower(hex(randomblob(16))) AS salt
    FROM users
    WHERE app_password IS NOT NULL AND app_password != '';
INSERT INTO device_keys (id, user_id, name, salt, key_hash, created_at)
    SELECT lower(hex(randomblob(16))), user_id, 'Existing password', salt,
           citadel_sha256_hex(salt || app_password),
           CAST(strftime('%s', 'now') AS INTEGER)
    FROM migrating_app_passwords;
DROP TABLE migrating_app_passwords;

ALTER TABLE users DROP COLUMN app_password;
