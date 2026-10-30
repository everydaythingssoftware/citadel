-- Users' own third-party API keys (e.g. Hardcover), sealed with the vault key
-- in the host's state directory (ADR 0011). key_id names that key so rows
-- sealed with a lost or replaced key are recognised as needing re-entry.
CREATE TABLE provider_credentials (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    key_id TEXT NOT NULL,
    nonce BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    -- The provider account's name, shown so the secret never has to be.
    label TEXT,
    created_at BIGINT NOT NULL,
    verified_at BIGINT,
    PRIMARY KEY (user_id, provider)
);
