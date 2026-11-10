-- A grant may let its user browse a library without changing it (ADR 0014).
-- Existing grants keep editing.
ALTER TABLE library_grants ADD COLUMN can_edit BOOLEAN NOT NULL DEFAULT 1;
