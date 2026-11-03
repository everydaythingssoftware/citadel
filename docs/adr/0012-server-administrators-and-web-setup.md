# 12. Server administrators and web setup

Status: Accepted - 2026-11-03 (CDL-39)

## Context

The server could only serve a library named in its config file, opened before
anything else, and every user was created from the command line (ADR 0009).
Someone starting Citadel Server for the first time had to edit a file and run
a command before a browser could show anything. CDL-39 asks for the whole
first run to happen in the browser, without ordinary readers gaining any
power over the server's filesystem.

## Decision

**Roles.** `users.role` is a text column, `reader` or `administrator`.
Administrators may set the server up and, later, administer it; grants still
decide which libraries anyone sees, so an administrator has no implicit
access to a library they didn't create or adopt. The migration that adds the
column makes every existing user an administrator, since all of them were
created by the operator's CLI. The desktop's local user is an administrator.
A third role arrives by ordinary migration.

**Bootstrap.** When the API is enabled and no administrator exists, the server
prints a one-time setup code on stdout at each start, such as
`K7QD-M2XV-H9RW` (31 unambiguous characters, three groups of four). Whoever
can read the server's console is its operator, the same trust the CLI relies
on. `POST /api/setup/administrator` takes the code, a username and a password,
creates the administrator and signs them in; the code is consumed on success,
compared in constant time, and guesses share the sign-in back-off. The CLI
keeps `users add`, gains `users add --admin`, `users promote` and `users
demote` for scripts and for getting back in when no administrator can sign
in, and `libraries add <path>` for scripted deployments.

**The served library.** `libraryPath` leaves the config file and is rejected
with the replacement spelled out; `[api]` becomes mandatory, since the
browser is now how a server is set up. The registry in `citadel.db` is the
source of truth, with a `properties` row `active_library_id` naming the one
library served; one library at a time for now, and a second create, adopt or
`libraries add` answers 409. Switching libraries and per-user libraries are
later work that nothing here has to undo.

**Setup mode.** The server starts without a library: the API listens, library
routes answer 503 "No library is set up on this server yet", and OPDS waits
until a library is open and at least one user is granted it, then starts from
the existing two-second status loop. A registered library whose folder can't
be opened is reported, not fatal: administrators see why and can retry or
adopt it from where it moved to (the Calibre UUID must match; a different
library is refused).

**Paths.** Setup routes live under `/api/setup` behind a middleware that
requires an administrator; readers get 403, never a listing. The
administrator may type an absolute path or browse: `GET /api/setup/directories`
lists subfolders of any folder the process can read, dotfolders hidden, one
level per request, starting at the process's home or `/`. `POST
/api/setup/library/inspect` classifies a path (library with its size and
schema version, empty, not empty, missing, not a directory, denied, reserved,
relative). A library may not contain the state directory (the inverse of ADR
0003) and may not sit inside `secrets/` or `uploads/`. `POST
/api/setup/library` creates or adopts, registers the library under its Calibre
UUID with the given display name, grants the administrator, records the
choice and opens the library.

**Schema versions.** New libraries carry the schema a Calibre library holds at
version 28. Adopt reports the library's Calibre schema version and
whether Calibre's current format is newer. The administrator may upgrade at
adopt time or later through `POST /api/setup/library/upgrade`; libcalibre
runs Calibre's own steps after backing the database up beside it (CDL-66).
Nothing upgrades on open, and libraries older than libcalibre's minimum are
refused with advice to open them in Calibre once.

## Consequences

- A fresh server needs its config file for listeners and the public URL, and
  nothing else: start it, read the code, open the browser.
- `citadel.db` now holds which library is served. Backups of the state
  directory carry the choice; a config file no longer does.
- The browser's first-run flow (the next slice of CDL-39) and user management
  in the browser (CDL-67) build on the role and these routes.
- Operators who scripted `libraryPath` move to `libraries add`.
