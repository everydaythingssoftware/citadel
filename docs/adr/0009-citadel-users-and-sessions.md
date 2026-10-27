# 9. Citadel users, sessions and library grants

Status: Accepted - 2026-10-27 (CDL-45)

## Context

The headless server signed browsers in with OPDS-branded HTTP Basic credentials
from `CITADEL_OPDS_USERS`. Browsers showed their own Basic dialog, could not sign
out, and every user saw every library. OIDC (CDL-46), remote editing (CDL-37),
multiple libraries and roles all need a user model they can extend without risky
migrations.

## Decision

`citadel-core` owns `citadel.db` (`citadel_core::store`) alongside the library
contracts: the database is Citadel's own state, not only accounts, and both
hosts use it. Each host keeps it in its state directory (the server's
`stateDirectory`, the desktop's app-data directory), never inside a library
(ADR 0003). It is one concrete SQLite store; traits wait for a second backend.
Diesel embeds its migrations. Tables:

- `users`: opaque UUID `id`; `username` is unique case-insensitively and for
  display only. Sign-in passwords are Argon2id hashes and may be absent
  (OIDC-only users, the desktop's local user). `app_password` is the user's
  OPDS password, stored reversibly so it can be revealed again (ADR 0005); it
  may be absent.
- `external_identities`: `(issuer, subject)` → user. Empty until OIDC; a user
  may have several.
- `sessions`: SHA-256 of an opaque 256-bit cookie token → user, with a 30-day
  sliding expiry. Revocation deletes rows; there are no JWTs.
- `libraries`: the registry, keyed by the library's Calibre UUID (Calibre's
  `library_id` table), with a display name and the canonical path it was last
  opened from. A library that moves keeps its ID, name and grants. A copied
  library shares its original's UUID, so registering the copy moves the entry
  to it; telling such copies apart is deferred.
- `properties`: installation-wide values, such as the desktop's local user ID.
- `library_grants`: user × library. v1 is binary access. A library a user cannot
  access is invisible: its routes answer 404, and its OPDS catalog rejects the
  user's app password.

The store is split by concern: `users` (accounts and sign-in passwords),
`auth` (password checks, sessions, app passwords, grants), `libraries` (the
registry) and `migrations`.

Migrations run whenever a host opens the store. Pending migrations apply
together in one transaction, so a failed run leaves the database as it was.
Before migrating an existing database, Citadel writes a consistent snapshot
next to it with `VACUUM INTO` (`citadel.db.backup-<last applied version>`,
newest three kept) and names it in any migration error. Backup and migration
hold an exclusive lock on `citadel.db.lock`, so concurrent processes migrate
once. A database migrated by a newer build, or whose pending migrations would
apply out of order, is refused rather than opened. Restoring a backup is a
manual copy; Citadel never restores one automatically.

The server always requires sign-in; `sharing.authenticationEnabled` and
`CITADEL_OPDS_USERS` are removed and rejected with migration hints.

Browsers sign in with `POST /api/session`, which sets an `HttpOnly`,
`SameSite=Lax`, `Path=/` cookie, `Secure` when `api.publicUrl` is https. Every API
request looks the session, user and grant up again. Unsafe methods must carry
the `api.publicUrl` origin when they carry an `Origin` header. Failed sign-ins
back off like OPDS Basic. The built frontend is public so signed-out browsers can
load the sign-in form; all data comes from the protected API.

OPDS remains HTTP Basic, checked against the app passwords of users granted the
served library. The server reloads that list from `citadel.db` every two seconds
so admin changes apply without a restart.

The operator is the administrator. `citadel-server --config <path> users …`,
`grant` and `revoke` edit `citadel.db` from a separate process; `users add`
grants the configured library and prints generated passwords once. There is no
onboarding or administration UI.

Every `LibraryService` write takes an `Actor`. The desktop passes its local
user; the server will pass the session's user when write routes land. The enum
is non-exhaustive so non-human actors can follow.

### Desktop

The desktop app has one real user, the local user, created on first launch and
named after the OS account. It has no sign-in password. Its app password is the
desktop's OPDS sharing password: Sharing settings reveal, set, generate and
clear it, and choosing an OPDS username renames the local user. Desktop sharing
may still run without sign-in on local networks; only the server always
requires it.

On first launch after upgrading, `opds-credentials.json` becomes the local
user's name and app password and is deleted; unreadable verifier-format files
are discarded.

## Consequences

Users, grants and app passwords are per installation, not per library:
copying a library never copies access. The OPDS runtime no longer persists
credentials; hosts supply them from `citadel.db`. The desktop's `settings.json`
library list moves into the registry in a follow-up.

Deferred without blocking this model: roles beyond access, library owners,
instance permissions, anonymous access, download-only permission, sign-up,
account linking, desktop-to-server tokens, audit logs (CDL-48), analytics
(CDL-49), and detecting duplicate library IDs.
