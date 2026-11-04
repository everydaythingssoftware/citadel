-- Serve this library without changing it, for people who keep managing it
-- in Calibre on another computer.
ALTER TABLE libraries ADD COLUMN read_only BOOLEAN NOT NULL DEFAULT 0;
