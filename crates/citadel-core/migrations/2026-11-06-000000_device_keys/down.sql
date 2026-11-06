-- Keys are kept only as hashes, so app passwords can't be restored.
ALTER TABLE users ADD COLUMN app_password TEXT;
DROP TABLE device_keys;
