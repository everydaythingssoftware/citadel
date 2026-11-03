-- Who may administer the server (set up libraries, manage users). Everyone
-- who exists already was created by the operator's CLI, so they all become
-- administrators; new users are readers unless made otherwise.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'reader';
UPDATE users SET role = 'administrator';
